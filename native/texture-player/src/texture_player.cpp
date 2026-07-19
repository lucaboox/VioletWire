#include <napi.h>

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <gl/GL.h>
#include <wrl/client.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr GLenum kGlFramebuffer = 0x8D40;
constexpr GLenum kGlRenderbuffer = 0x8D41;
constexpr GLenum kGlColorAttachment0 = 0x8CE0;
constexpr GLenum kGlFramebufferComplete = 0x8CD5;
constexpr GLenum kGlRgba8 = 0x8058;
constexpr GLenum kWglAccessWriteDiscardNv = 0x0002;

using GlGenFramebuffers = void(APIENTRY*)(GLsizei, GLuint*);
using GlDeleteFramebuffers = void(APIENTRY*)(GLsizei, const GLuint*);
using GlBindFramebuffer = void(APIENTRY*)(GLenum, GLuint);
using GlCheckFramebufferStatus = GLenum(APIENTRY*)(GLenum);
using GlFramebufferRenderbuffer = void(APIENTRY*)(GLenum, GLenum, GLenum, GLuint);
using GlGenRenderbuffers = void(APIENTRY*)(GLsizei, GLuint*);
using GlDeleteRenderbuffers = void(APIENTRY*)(GLsizei, const GLuint*);
using WglDxOpenDeviceNv = HANDLE(WINAPI*)(void*);
using WglDxCloseDeviceNv = BOOL(WINAPI*)(HANDLE);
using WglDxRegisterObjectNv = HANDLE(WINAPI*)(HANDLE, void*, GLuint, GLenum, GLenum);
using WglDxUnregisterObjectNv = BOOL(WINAPI*)(HANDLE, HANDLE);
using WglDxLockObjectsNv = BOOL(WINAPI*)(HANDLE, GLint, HANDLE*);
using WglDxUnlockObjectsNv = BOOL(WINAPI*)(HANDLE, GLint, HANDLE*);

struct MpvApi {
  decltype(&mpv_create) create = nullptr;
  decltype(&mpv_initialize) initialize = nullptr;
  decltype(&mpv_set_option_string) set_option_string = nullptr;
  decltype(&mpv_observe_property) observe_property = nullptr;
  decltype(&mpv_command_async) command_async = nullptr;
  decltype(&mpv_wait_event) wait_event = nullptr;
  decltype(&mpv_terminate_destroy) terminate_destroy = nullptr;
  decltype(&mpv_error_string) error_string = nullptr;
  decltype(&mpv_render_context_create) render_context_create = nullptr;
  decltype(&mpv_render_context_set_update_callback) render_context_set_update_callback = nullptr;
  decltype(&mpv_render_context_update) render_context_update = nullptr;
  decltype(&mpv_render_context_render) render_context_render = nullptr;
  decltype(&mpv_render_context_free) render_context_free = nullptr;
};

template <typename T>
bool LoadFunction(HMODULE module, const char* name, T& target) {
  target = reinterpret_cast<T>(GetProcAddress(module, name));
  return target != nullptr;
}

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  std::wstring result(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size);
  return result;
}

struct SharedFrame {
  uint32_t slot = 0;
  uint64_t handle = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  uint64_t sequence = 0;
};

struct PlayerEvent {
  std::string type;
  bool boolean_value = false;
  double number_value = 0;
  std::string text;
};

class TexturePlayer final : public Napi::ObjectWrap<TexturePlayer> {
 public:
  static Napi::Function Define(Napi::Env env) {
    return DefineClass(
      env,
      "TexturePlayer",
      {
        InstanceMethod("start", &TexturePlayer::Start),
        InstanceMethod("resize", &TexturePlayer::Resize),
        InstanceMethod("command", &TexturePlayer::Command),
        InstanceMethod("recoverGraphics", &TexturePlayer::RecoverGraphics),
        InstanceMethod("releaseFrame", &TexturePlayer::ReleaseFrame),
        InstanceMethod("destroy", &TexturePlayer::DestroyFromJs),
      }
    );
  }

  explicit TexturePlayer(const Napi::CallbackInfo& info)
      : Napi::ObjectWrap<TexturePlayer>(info) {
    if (info.Length() < 3 || !info[0].IsFunction() || !info[1].IsFunction() || !info[2].IsString()) {
      throw Napi::TypeError::New(
        info.Env(),
        "TexturePlayer requires frame callback, event callback, and libmpv DLL path."
      );
    }

    frame_callback_ = Napi::ThreadSafeFunction::New(
      info.Env(),
      info[0].As<Napi::Function>(),
      "VioletWire texture frames",
      2,
      1
    );
    event_callback_ = Napi::ThreadSafeFunction::New(
      info.Env(),
      info[1].As<Napi::Function>(),
      "VioletWire texture events",
      32,
      1
    );

    const auto dll_path = Utf8ToWide(info[2].As<Napi::String>().Utf8Value());
    module_ = LoadLibraryW(dll_path.c_str());
    if (!module_) {
      throw Napi::Error::New(info.Env(), "Unable to load the bundled libmpv-2.dll.");
    }
    if (!LoadMpvApi()) {
      FreeLibrary(module_);
      module_ = nullptr;
      throw Napi::Error::New(info.Env(), "The bundled libmpv API is incomplete.");
    }
  }

  ~TexturePlayer() override {
    Stop();
    frame_callback_.Release();
    event_callback_.Release();
    if (module_) FreeLibrary(module_);
  }

 private:
  // A slot is owned by exactly one party at a time: kFree (available to the
  // render thread), kRendering (render thread is producing into it, with the
  // slot mutex RELEASED during GPU work), or kExported (Chromium holds it
  // until ReleaseFrame). ReleaseFrame must only ever free kExported slots so
  // in-progress GPU work can safely run outside the lock.
  enum class SlotState { kFree, kRendering, kExported };

  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11Texture2D> gl_texture;
    ComPtr<IDXGIKeyedMutex> keyed_mutex;
    HANDLE handle = nullptr;
    HANDLE gl_interop_object = nullptr;
    GLuint gl_renderbuffer = 0;
    GLuint gl_framebuffer = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    uint64_t device_generation = 0;
    SlotState state = SlotState::kFree;
  };

  bool LoadMpvApi() {
    return LoadFunction(module_, "mpv_create", api_.create) &&
      LoadFunction(module_, "mpv_initialize", api_.initialize) &&
      LoadFunction(module_, "mpv_set_option_string", api_.set_option_string) &&
      LoadFunction(module_, "mpv_observe_property", api_.observe_property) &&
      LoadFunction(module_, "mpv_command_async", api_.command_async) &&
      LoadFunction(module_, "mpv_wait_event", api_.wait_event) &&
      LoadFunction(module_, "mpv_terminate_destroy", api_.terminate_destroy) &&
      LoadFunction(module_, "mpv_error_string", api_.error_string) &&
      LoadFunction(module_, "mpv_render_context_create", api_.render_context_create) &&
      LoadFunction(
        module_,
        "mpv_render_context_set_update_callback",
        api_.render_context_set_update_callback
      ) &&
      LoadFunction(module_, "mpv_render_context_update", api_.render_context_update) &&
      LoadFunction(module_, "mpv_render_context_render", api_.render_context_render) &&
      LoadFunction(module_, "mpv_render_context_free", api_.render_context_free);
  }

  Napi::Value Start(const Napi::CallbackInfo& info) {
    auto env = info.Env();
    if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
      throw Napi::TypeError::New(env, "start requires a URL, width, and height.");
    }
    Stop();

    width_ = std::clamp(info[1].As<Napi::Number>().Uint32Value(), 320u, 3840u);
    height_ = std::clamp(info[2].As<Napi::Number>().Uint32Value(), 180u, 2160u);
    preferred_vendor_id_ =
      info.Length() >= 4 && info[3].IsNumber() ? info[3].As<Napi::Number>().Uint32Value() : 0;
    preferred_device_id_ =
      info.Length() >= 5 && info[4].IsNumber() ? info[4].As<Napi::Number>().Uint32Value() : 0;

    adapter_index_ = 0;
    device_generation_ = 0;
    if (!CreateGraphicsDevice(false)) {
      throw Napi::Error::New(env, "D3D11 is unavailable for the embedded Native player.");
    }

    mpv_ = api_.create();
    if (!mpv_) throw Napi::Error::New(env, "libmpv could not create a playback context.");
    api_.set_option_string(mpv_, "vo", "libmpv");
    api_.set_option_string(mpv_, "terminal", "no");
    api_.set_option_string(mpv_, "input-default-bindings", "no");
    api_.set_option_string(mpv_, "osc", "no");
    api_.set_option_string(mpv_, "profile", "low-latency");
    // NVIDIA can hand decoded frames directly to mpv's OpenGL renderer. Other
    // Windows vendors currently use D3D11VA's system-memory copy path before
    // the GPU render stage. Keep auto-copy last so decoding remains functional
    // when a driver-specific decoder is unavailable.
    api_.set_option_string(
      mpv_,
      "hwdec",
      preferred_vendor_id_ == 0x10de
        ? "nvdec,d3d11va-copy,auto-copy"
        : "d3d11va-copy,auto-copy"
    );
    // Bilinear scaling keeps the software fallback inexpensive. The OpenGL
    // fast path performs this scaling on the GPU.
    api_.set_option_string(mpv_, "sws-fast", "yes");
    api_.set_option_string(mpv_, "sws-scaler", "bilinear");
    api_.set_option_string(mpv_, "keep-open", "no");
    // Every input this bridge ever opens is a Twitch HLS playlist. Telling
    // ffmpeg the container up front skips its format probing on each stream
    // open and channel switch, trimming first-frame latency.
    api_.set_option_string(mpv_, "demuxer-lavf-format", "hls");
    if (api_.initialize(mpv_) < 0) {
      Stop();
      throw Napi::Error::New(env, "libmpv could not initialize.");
    }

    if (!InitializeOpenGlRenderer() && !InitializeSoftwareRenderer()) {
      Stop();
      throw Napi::Error::New(
        env,
        "This libmpv build could not initialize a compatible embedded render API."
      );
    }

    api_.render_context_set_update_callback(render_context_, &TexturePlayer::OnRenderUpdate, this);
    api_.observe_property(mpv_, 1, "pause", MPV_FORMAT_FLAG);
    api_.observe_property(mpv_, 2, "mute", MPV_FORMAT_FLAG);
    api_.observe_property(mpv_, 3, "volume", MPV_FORMAT_DOUBLE);

    running_ = true;
    render_thread_ = std::thread(&TexturePlayer::RenderLoop, this);
    event_thread_ = std::thread(&TexturePlayer::EventLoop, this);

    // An empty URL initializes the whole graphics/mpv pipeline without
    // loading anything, so callers can overlap this startup with stream-URL
    // resolution and send "loadfile" afterwards.
    const std::string url = info[0].As<Napi::String>().Utf8Value();
    if (!url.empty()) {
      const char* command[] = {"loadfile", url.c_str(), "replace", nullptr};
      api_.command_async(mpv_, 0, command);
    }
    RequestRender();
    return env.Undefined();
  }

  Napi::Value Resize(const Napi::CallbackInfo& info) {
    if (info.Length() >= 2 && info[0].IsNumber() && info[1].IsNumber()) {
      const auto next_width = std::clamp(info[0].As<Napi::Number>().Uint32Value(), 320u, 3840u);
      const auto next_height = std::clamp(info[1].As<Napi::Number>().Uint32Value(), 180u, 2160u);
      if (next_width != width_ || next_height != height_) {
        width_ = next_width;
        height_ = next_height;
      }
      RequestRender();
    }
    return info.Env().Undefined();
  }

  Napi::Value Command(const Napi::CallbackInfo& info) {
    if (!mpv_ || info.Length() < 1 || !info[0].IsArray()) return info.Env().Undefined();
    const auto input = info[0].As<Napi::Array>();
    std::vector<std::string> values;
    values.reserve(input.Length());
    for (uint32_t index = 0; index < input.Length(); ++index) {
      if (!input.Get(index).IsString()) {
        throw Napi::TypeError::New(info.Env(), "Every libmpv command argument must be a string.");
      }
      values.push_back(input.Get(index).As<Napi::String>().Utf8Value());
    }
    std::vector<const char*> command;
    command.reserve(values.size() + 1);
    for (const auto& value : values) command.push_back(value.c_str());
    command.push_back(nullptr);
    api_.command_async(mpv_, 0, command.data());
    return info.Env().Undefined();
  }

  Napi::Value RecoverGraphics(const Napi::CallbackInfo& info) {
    const bool cycle_adapter =
      info.Length() >= 1 && info[0].IsBoolean() && info[0].As<Napi::Boolean>().Value();
    const int requested_mode = cycle_adapter ? 2 : 1;
    int current_mode = graphics_recovery_requested_.load();
    while (
      current_mode < requested_mode &&
      !graphics_recovery_requested_.compare_exchange_weak(current_mode, requested_mode)
    ) {
    }
    RequestRender();
    return info.Env().Undefined();
  }

  Napi::Value ReleaseFrame(const Napi::CallbackInfo& info) {
    if (info.Length() >= 1 && info[0].IsNumber()) {
      const uint32_t index = info[0].As<Napi::Number>().Uint32Value();
      {
        std::scoped_lock lock(slot_mutex_);
        if (index < slots_.size()) {
          auto& slot = slots_[index];
          // Only Chromium-held slots may be freed here. A slot in kRendering
          // is being written outside the lock and a stale release (for
          // example after a device recovery reset it) must not touch it.
          if (slot.state == SlotState::kExported) slot.state = SlotState::kFree;
        }
      }
      // If every slot was in Chromium when mpv announced its latest frame,
      // there may be no second update callback. Releasing a slot must wake the
      // renderer so the newest available frame can be presented.
      RequestRender();
    }
    return info.Env().Undefined();
  }

  Napi::Value DestroyFromJs(const Napi::CallbackInfo& info) {
    Stop();
    return info.Env().Undefined();
  }

  static void OnRenderUpdate(void* context) {
    static_cast<TexturePlayer*>(context)->RequestRender();
  }

  void RequestRender() {
    render_requested_ = true;
    render_condition_.notify_one();
  }

  // After mpv announces MPV_RENDER_UPDATE_FRAME, the frame must be consumed
  // even when this bridge cannot present it. Skipping through the render API
  // lets mpv advance its frame queue and keep A/V pacing intact instead of
  // accumulating genuinely dropped frames.
  void SkipMpvFrame() {
    if (!render_context_) return;
    int skip = 1;
    mpv_render_param params[] = {
      {MPV_RENDER_PARAM_SKIP_RENDERING, &skip},
      {MPV_RENDER_PARAM_INVALID, nullptr},
    };
    api_.render_context_render(render_context_, params);
  }

  static LRESULT CALLBACK HiddenWindowProc(
    HWND window,
    UINT message,
    WPARAM wparam,
    LPARAM lparam
  ) {
    return DefWindowProcW(window, message, wparam, lparam);
  }

  static void* GetOpenGlProcAddress(void*, const char* name) {
    void* address = reinterpret_cast<void*>(wglGetProcAddress(name));
    if (
      !address ||
      address == reinterpret_cast<void*>(1) ||
      address == reinterpret_cast<void*>(2) ||
      address == reinterpret_cast<void*>(3) ||
      address == reinterpret_cast<void*>(-1)
    ) {
      const HMODULE opengl = GetModuleHandleW(L"opengl32.dll");
      address = opengl ? reinterpret_cast<void*>(GetProcAddress(opengl, name)) : nullptr;
    }
    return address;
  }

  template <typename T>
  static bool LoadOpenGlFunction(const char* name, T& target) {
    target = reinterpret_cast<T>(GetOpenGlProcAddress(nullptr, name));
    return target != nullptr;
  }

  bool CreateOpenGlContext() {
    open_gl_failure_.clear();
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    constexpr wchar_t class_name[] = L"VioletWireTextureOpenGL";
    WNDCLASSW window_class{};
    window_class.style = CS_OWNDC;
    window_class.lpfnWndProc = &TexturePlayer::HiddenWindowProc;
    window_class.hInstance = instance;
    window_class.lpszClassName = class_name;
    if (!RegisterClassW(&window_class) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
      open_gl_failure_ = "the hidden OpenGL window class could not be registered";
      return false;
    }

    gl_window_ = CreateWindowExW(
      0,
      class_name,
      L"",
      WS_POPUP,
      0,
      0,
      1,
      1,
      nullptr,
      nullptr,
      instance,
      nullptr
    );
    if (!gl_window_) {
      open_gl_failure_ = "the hidden OpenGL window could not be created";
      return false;
    }
    gl_dc_ = GetDC(gl_window_);
    if (!gl_dc_) {
      open_gl_failure_ = "the OpenGL device context could not be created";
      return false;
    }

    PIXELFORMATDESCRIPTOR descriptor{};
    descriptor.nSize = sizeof(descriptor);
    descriptor.nVersion = 1;
    descriptor.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
    descriptor.iPixelType = PFD_TYPE_RGBA;
    descriptor.cColorBits = 32;
    descriptor.cAlphaBits = 8;
    descriptor.iLayerType = PFD_MAIN_PLANE;
    const int pixel_format = ChoosePixelFormat(gl_dc_, &descriptor);
    if (!pixel_format || !SetPixelFormat(gl_dc_, pixel_format, &descriptor)) {
      open_gl_failure_ = "the OpenGL pixel format could not be selected";
      return false;
    }

    gl_context_ = wglCreateContext(gl_dc_);
    if (!gl_context_ || !wglMakeCurrent(gl_dc_, gl_context_)) {
      open_gl_failure_ = "the desktop OpenGL context could not be activated";
      return false;
    }

    const bool gl_loaded =
      LoadOpenGlFunction("glGenFramebuffers", gl_gen_framebuffers_) &&
      LoadOpenGlFunction("glDeleteFramebuffers", gl_delete_framebuffers_) &&
      LoadOpenGlFunction("glBindFramebuffer", gl_bind_framebuffer_) &&
      LoadOpenGlFunction("glCheckFramebufferStatus", gl_check_framebuffer_status_) &&
      LoadOpenGlFunction("glFramebufferRenderbuffer", gl_framebuffer_renderbuffer_) &&
      LoadOpenGlFunction("glGenRenderbuffers", gl_gen_renderbuffers_) &&
      LoadOpenGlFunction("glDeleteRenderbuffers", gl_delete_renderbuffers_);
    if (!gl_loaded) {
      open_gl_failure_ = "the driver does not expose framebuffer objects";
      return false;
    }
    const bool interop_loaded =
      LoadOpenGlFunction("wglDXOpenDeviceNV", wgl_dx_open_device_) &&
      LoadOpenGlFunction("wglDXCloseDeviceNV", wgl_dx_close_device_) &&
      LoadOpenGlFunction("wglDXRegisterObjectNV", wgl_dx_register_object_) &&
      LoadOpenGlFunction("wglDXUnregisterObjectNV", wgl_dx_unregister_object_) &&
      LoadOpenGlFunction("wglDXLockObjectsNV", wgl_dx_lock_objects_) &&
      LoadOpenGlFunction("wglDXUnlockObjectsNV", wgl_dx_unlock_objects_);
    if (!interop_loaded) {
      open_gl_failure_ = "the active OpenGL driver does not expose WGL_NV_DX_interop2";
      return false;
    }

    gl_interop_device_ = wgl_dx_open_device_(device_.Get());
    if (!gl_interop_device_) {
      open_gl_failure_ = "OpenGL could not open the selected D3D11 adapter";
      return false;
    }
    if (!ProbeOpenGlInterop()) {
      open_gl_failure_ = "the driver rejected VioletWire's D3D11 render target";
      return false;
    }
    return true;
  }

  bool ProbeOpenGlInterop() {
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width_.load();
    description.Height = height_.load();
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    // WGL interop drivers commonly reject keyed/NTHANDLE resources. Render
    // into a private D3D11 target and perform one GPU CopyResource into the
    // Electron-facing keyed texture instead.
    description.MiscFlags = 0;
    ComPtr<ID3D11Texture2D> texture;
    if (FAILED(device_->CreateTexture2D(&description, nullptr, &texture))) return false;

    GLuint renderbuffer = 0;
    GLuint framebuffer = 0;
    HANDLE interop_object = nullptr;
    gl_gen_renderbuffers_(1, &renderbuffer);
    if (renderbuffer) {
      interop_object = wgl_dx_register_object_(
        gl_interop_device_,
        texture.Get(),
        renderbuffer,
        kGlRenderbuffer,
        kWglAccessWriteDiscardNv
      );
    }

    bool complete = false;
    if (
      interop_object &&
      wgl_dx_lock_objects_(gl_interop_device_, 1, &interop_object)
    ) {
      gl_gen_framebuffers_(1, &framebuffer);
      gl_bind_framebuffer_(kGlFramebuffer, framebuffer);
      gl_framebuffer_renderbuffer_(
        kGlFramebuffer,
        kGlColorAttachment0,
        kGlRenderbuffer,
        renderbuffer
      );
      complete = gl_check_framebuffer_status_(kGlFramebuffer) == kGlFramebufferComplete;
      gl_bind_framebuffer_(kGlFramebuffer, 0);
      wgl_dx_unlock_objects_(gl_interop_device_, 1, &interop_object);
    }

    if (framebuffer) gl_delete_framebuffers_(1, &framebuffer);
    if (interop_object) wgl_dx_unregister_object_(gl_interop_device_, interop_object);
    if (renderbuffer) gl_delete_renderbuffers_(1, &renderbuffer);
    return complete;
  }

  bool InitializeOpenGlRenderer() {
    if (!CreateOpenGlContext()) {
      DestroyOpenGlRenderer();
      EmitEvent({
        "renderer",
        false,
        0,
        "OpenGL/D3D11 interop is unavailable because " + open_gl_failure_ +
          "; using the compatible software renderer.",
      });
      return false;
    }

    const char* api_type = MPV_RENDER_API_TYPE_OPENGL;
    mpv_opengl_init_params open_gl_params{
      &TexturePlayer::GetOpenGlProcAddress,
      nullptr,
    };
    mpv_render_param create_params[] = {
      {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(api_type)},
      {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &open_gl_params},
      {MPV_RENDER_PARAM_INVALID, nullptr},
    };
    const int result = api_.render_context_create(&render_context_, mpv_, create_params);
    wglMakeCurrent(nullptr, nullptr);
    if (result < 0) {
      render_context_ = nullptr;
      DestroyOpenGlRenderer();
      EmitEvent({
        "renderer",
        false,
        static_cast<double>(result),
        "libmpv rejected the OpenGL render API; using the compatible software renderer.",
      });
      return false;
    }

    use_open_gl_ = true;
    EmitEvent({
      "renderer",
      false,
      0,
      preferred_vendor_id_ == 0x10de
        ? "Using the GPU OpenGL renderer with direct NVIDIA decoding when available."
        : "Using the GPU OpenGL renderer with D3D11VA copy decoding.",
    });
    return true;
  }

  bool InitializeSoftwareRenderer() {
    const char* api_type = MPV_RENDER_API_TYPE_SW;
    mpv_render_param create_params[] = {
      {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(api_type)},
      {MPV_RENDER_PARAM_INVALID, nullptr},
    };
    use_open_gl_ = false;
    return api_.render_context_create(&render_context_, mpv_, create_params) >= 0;
  }

  void DestroyOpenGlRenderer() {
    if (gl_context_ && gl_dc_) wglMakeCurrent(gl_dc_, gl_context_);
    {
      std::scoped_lock lock(slot_mutex_);
      for (auto& slot : slots_) ResetSlotOpenGlLocked(slot);
    }
    if (gl_interop_device_ && wgl_dx_close_device_) {
      wgl_dx_close_device_(gl_interop_device_);
      gl_interop_device_ = nullptr;
    }
    if (gl_context_) {
      wglMakeCurrent(nullptr, nullptr);
      wglDeleteContext(gl_context_);
      gl_context_ = nullptr;
    }
    if (gl_dc_ && gl_window_) {
      ReleaseDC(gl_window_, gl_dc_);
      gl_dc_ = nullptr;
    }
    if (gl_window_) {
      DestroyWindow(gl_window_);
      gl_window_ = nullptr;
    }
    use_open_gl_ = false;
  }

  bool CreateGraphicsDevice(bool cycle_adapter) {
    ComPtr<IDXGIFactory1> factory;
    std::vector<ComPtr<IDXGIAdapter1>> adapters;
    if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
      for (uint32_t index = 0;; ++index) {
        ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(index, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        DXGI_ADAPTER_DESC1 description{};
        if (
          SUCCEEDED(adapter->GetDesc1(&description)) &&
          (description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0
        ) {
          adapters.push_back(std::move(adapter));
        }
      }
    }

    if (
      !cycle_adapter &&
      device_generation_ == 0 &&
      preferred_vendor_id_ != 0 &&
      preferred_device_id_ != 0
    ) {
      for (uint32_t index = 0; index < adapters.size(); ++index) {
        DXGI_ADAPTER_DESC1 description{};
        if (
          SUCCEEDED(adapters[index]->GetDesc1(&description)) &&
          description.VendorId == preferred_vendor_id_ &&
          description.DeviceId == preferred_device_id_
        ) {
          adapter_index_ = index;
          break;
        }
      }
    } else if (cycle_adapter && !adapters.empty()) {
      adapter_index_ = (adapter_index_ + 1) % static_cast<uint32_t>(adapters.size());
    } else if (!adapters.empty() && adapter_index_ >= adapters.size()) {
      adapter_index_ = 0;
    }

    ComPtr<ID3D11Device> next_device;
    ComPtr<ID3D11DeviceContext> next_context;
    const HRESULT result = D3D11CreateDevice(
      adapters.empty() ? nullptr : adapters[adapter_index_].Get(),
      adapters.empty() ? D3D_DRIVER_TYPE_HARDWARE : D3D_DRIVER_TYPE_UNKNOWN,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      &next_device,
      nullptr,
      &next_context
    );
    if (FAILED(result)) {
      EmitEvent({
        "diagnostic",
        false,
        static_cast<double>(static_cast<uint32_t>(result)),
        "D3D11 device creation failed",
      });
      return false;
    }

    {
      std::scoped_lock lock(slot_mutex_);
      if (use_open_gl_) {
        // Recovery creates entirely new resources. Chromium retains its own
        // reference to any already-imported old texture, so those slots can be
        // retired without reusing memory that the compositor may still read.
        ResetSlotsLocked();
        if (gl_interop_device_ && wgl_dx_close_device_) {
          wgl_dx_close_device_(gl_interop_device_);
          gl_interop_device_ = nullptr;
        }
      } else {
        for (auto& slot : slots_) {
          if (slot.state == SlotState::kFree) ResetSlotLocked(slot);
        }
      }
      device_ = std::move(next_device);
      device_context_ = std::move(next_context);
      ++device_generation_;
      if (use_open_gl_) {
        gl_interop_device_ = wgl_dx_open_device_(device_.Get());
        if (!gl_interop_device_) {
          EmitEvent({
            "error",
            false,
            static_cast<double>(GetLastError()),
            "OpenGL could not reconnect to the recovered D3D11 device.",
          });
          return false;
        }
      }
    }
    EmitEvent({
      "diagnostic",
      false,
      static_cast<double>(adapter_index_),
      cycle_adapter
        ? "Recreated the texture device on the next graphics adapter."
        : "Recreated the texture graphics device.",
    });
    return true;
  }

  bool EnsureSlotLocked(uint32_t index, uint32_t width, uint32_t height) {
    auto& slot = slots_[index];
    if (
      slot.texture &&
      slot.width == width &&
      slot.height == height &&
      slot.device_generation == device_generation_ &&
      (!use_open_gl_ || slot.gl_interop_object)
    ) {
      return true;
    }
    if (slot.state != SlotState::kFree) return false;
    ResetSlotLocked(slot);

    D3D11_TEXTURE2D_DESC description{};
    description.Width = width;
    description.Height = height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    description.MiscFlags =
      D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
    const HRESULT texture_result = device_->CreateTexture2D(&description, nullptr, &slot.texture);
    if (FAILED(texture_result)) {
      EmitEvent({
        "diagnostic",
        false,
        static_cast<double>(static_cast<uint32_t>(texture_result)),
        "CreateTexture2D failed",
      });
      return false;
    }

    ComPtr<IDXGIResource1> resource;
    const HRESULT query_result = slot.texture.As(&resource);
    if (FAILED(query_result)) {
      EmitEvent({
        "diagnostic",
        false,
        static_cast<double>(static_cast<uint32_t>(query_result)),
        "IDXGIResource1 query failed",
      });
      return false;
    }
    const HRESULT handle_result = resource->CreateSharedHandle(
          nullptr,
          DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
          nullptr,
          &slot.handle
        );
    if (FAILED(handle_result)) {
      EmitEvent({
        "diagnostic",
        false,
        static_cast<double>(static_cast<uint32_t>(handle_result)),
        "CreateSharedHandle failed",
      });
      slot.texture.Reset();
      return false;
    }
    const HRESULT mutex_result = slot.texture.As(&slot.keyed_mutex);
    if (FAILED(mutex_result)) {
      EmitEvent({
        "diagnostic",
        false,
        static_cast<double>(static_cast<uint32_t>(mutex_result)),
        "IDXGIKeyedMutex query failed",
      });
      CloseHandle(slot.handle);
      slot.handle = nullptr;
      slot.texture.Reset();
      return false;
    }
    slot.width = width;
    slot.height = height;
    slot.device_generation = device_generation_;
    if (use_open_gl_) {
      D3D11_TEXTURE2D_DESC gl_description = description;
      gl_description.MiscFlags = 0;
      const HRESULT gl_texture_result =
        device_->CreateTexture2D(&gl_description, nullptr, &slot.gl_texture);
      if (FAILED(gl_texture_result) || !RegisterSlotOpenGlLocked(slot)) {
        ResetSlotLocked(slot);
        return false;
      }
    }
    return true;
  }

  bool RegisterSlotOpenGlLocked(Slot& slot) {
    if (
      !gl_interop_device_ ||
      !slot.gl_texture ||
      !gl_gen_renderbuffers_ ||
      !gl_gen_framebuffers_
    ) {
      return false;
    }

    gl_gen_renderbuffers_(1, &slot.gl_renderbuffer);
    if (!slot.gl_renderbuffer) return false;
    slot.gl_interop_object = wgl_dx_register_object_(
      gl_interop_device_,
      slot.gl_texture.Get(),
      slot.gl_renderbuffer,
      kGlRenderbuffer,
      kWglAccessWriteDiscardNv
    );
    if (!slot.gl_interop_object) {
      gl_delete_renderbuffers_(1, &slot.gl_renderbuffer);
      slot.gl_renderbuffer = 0;
      return false;
    }

    if (!wgl_dx_lock_objects_(gl_interop_device_, 1, &slot.gl_interop_object)) {
      ResetSlotOpenGlLocked(slot);
      return false;
    }
    gl_gen_framebuffers_(1, &slot.gl_framebuffer);
    gl_bind_framebuffer_(kGlFramebuffer, slot.gl_framebuffer);
    gl_framebuffer_renderbuffer_(
      kGlFramebuffer,
      kGlColorAttachment0,
      kGlRenderbuffer,
      slot.gl_renderbuffer
    );
    const bool complete =
      gl_check_framebuffer_status_(kGlFramebuffer) == kGlFramebufferComplete;
    gl_bind_framebuffer_(kGlFramebuffer, 0);
    wgl_dx_unlock_objects_(gl_interop_device_, 1, &slot.gl_interop_object);
    if (!complete) {
      ResetSlotOpenGlLocked(slot);
      return false;
    }
    return true;
  }

  void ResetSlotOpenGlLocked(Slot& slot) {
    if (slot.gl_interop_object && gl_interop_device_ && wgl_dx_unregister_object_) {
      wgl_dx_unregister_object_(gl_interop_device_, slot.gl_interop_object);
    }
    slot.gl_interop_object = nullptr;
    if (slot.gl_framebuffer && gl_delete_framebuffers_) {
      gl_delete_framebuffers_(1, &slot.gl_framebuffer);
    }
    slot.gl_framebuffer = 0;
    if (slot.gl_renderbuffer && gl_delete_renderbuffers_) {
      gl_delete_renderbuffers_(1, &slot.gl_renderbuffer);
    }
    slot.gl_renderbuffer = 0;
    slot.gl_texture.Reset();
  }

  void ResetSlotLocked(Slot& slot) {
    ResetSlotOpenGlLocked(slot);
    if (slot.handle) CloseHandle(slot.handle);
    slot.handle = nullptr;
    slot.keyed_mutex.Reset();
    slot.texture.Reset();
    slot.width = 0;
    slot.height = 0;
    slot.device_generation = 0;
    slot.state = SlotState::kFree;
  }

  void ResetSlotsLocked() {
    for (auto& slot : slots_) {
      ResetSlotLocked(slot);
    }
  }

  void RenderLoop() {
    if (use_open_gl_ && !wglMakeCurrent(gl_dc_, gl_context_)) {
      EmitEvent({
        "error",
        false,
        static_cast<double>(GetLastError()),
        "The accelerated renderer could not activate its OpenGL context.",
      });
      running_ = false;
      return;
    }

    while (running_) {
      {
        std::unique_lock lock(render_mutex_);
        render_condition_.wait(lock, [this] { return !running_ || render_requested_.exchange(false); });
      }
      if (!running_ || !render_context_) continue;

      const int recovery_mode = graphics_recovery_requested_.exchange(0);
      if (recovery_mode != 0 && !CreateGraphicsDevice(recovery_mode == 2)) {
        EmitEvent({"error", false, 0, "The embedded player could not recover its graphics device."});
        continue;
      }
      if (device_ && FAILED(device_->GetDeviceRemovedReason())) {
        if (!CreateGraphicsDevice(false)) {
          EmitEvent({"error", false, 0, "The embedded player lost its graphics device."});
          continue;
        }
      }

      const uint64_t update_flags = api_.render_context_update(render_context_);
      if ((update_flags & MPV_RENDER_UPDATE_FRAME) == 0) continue;

      const uint32_t width = width_.load();
      const uint32_t height = height_.load();
      uint32_t selected = static_cast<uint32_t>(slots_.size());
      HANDLE shared_handle = nullptr;
      ComPtr<ID3D11Texture2D> texture;
      ComPtr<ID3D11Texture2D> gl_texture;
      ComPtr<IDXGIKeyedMutex> keyed_mutex;
      HANDLE gl_interop_object = nullptr;
      GLuint gl_framebuffer = 0;
      {
        std::scoped_lock lock(slot_mutex_);
        for (uint32_t index = 0; index < slots_.size(); ++index) {
          if (
            slots_[index].state == SlotState::kFree &&
            EnsureSlotLocked(index, width, height)
          ) {
            selected = index;
            auto& slot = slots_[selected];
            slot.state = SlotState::kRendering;
            shared_handle = slot.handle;
            texture = slot.texture;
            gl_texture = slot.gl_texture;
            keyed_mutex = slot.keyed_mutex;
            gl_interop_object = slot.gl_interop_object;
            gl_framebuffer = slot.gl_framebuffer;
            break;
          }
        }
      }
      if (selected == slots_.size()) {
        // Every shared texture is still held by Chromium. The announced frame
        // must still be consumed so mpv's queue and A/V pacing advance.
        SkipMpvFrame();
        continue;
      }

      // All GPU work below runs with slot_mutex_ RELEASED. ReleaseFrame is
      // called on the Electron main thread after every presented frame; it
      // must never wait behind a render or a keyed-mutex acquisition. The
      // kRendering state guarantees exclusive ownership of this slot.
      const auto free_slot = [this, selected] {
        std::scoped_lock lock(slot_mutex_);
        slots_[selected].state = SlotState::kFree;
      };

      // The frame is disposable; a briefly contended compositor should cost
      // a dropped frame, not a second-long stall of the render thread.
      const HRESULT acquire_result = keyed_mutex->AcquireSync(0, 100);
      if (FAILED(acquire_result)) {
        free_slot();
        SkipMpvFrame();
        // Chromium can retain a shared texture briefly while replacing or
        // resizing its compositor surface. This frame is disposable; a
        // timeout must not permanently stop otherwise healthy playback.
        EmitEvent({
          "diagnostic",
          false,
          static_cast<double>(static_cast<uint32_t>(acquire_result)),
          "Dropped a video frame while waiting for its shared texture.",
        });
        continue;
      }

      int render_result = 0;
      if (use_open_gl_) {
        if (
          !gl_interop_object ||
          !wgl_dx_lock_objects_(gl_interop_device_, 1, &gl_interop_object)
        ) {
          keyed_mutex->ReleaseSync(0);
          free_slot();
          SkipMpvFrame();
          EmitEvent({
            "diagnostic",
            false,
            static_cast<double>(GetLastError()),
            "Dropped a frame because OpenGL could not lock its shared D3D11 texture.",
          });
          continue;
        }

        gl_bind_framebuffer_(kGlFramebuffer, gl_framebuffer);
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        mpv_opengl_fbo framebuffer{
          static_cast<int>(gl_framebuffer),
          static_cast<int>(width),
          static_cast<int>(height),
          static_cast<int>(kGlRgba8),
        };
        int flip_y = 0;
        mpv_render_param params[] = {
          {MPV_RENDER_PARAM_OPENGL_FBO, &framebuffer},
          {MPV_RENDER_PARAM_FLIP_Y, &flip_y},
          {MPV_RENDER_PARAM_INVALID, nullptr},
        };
        render_result = api_.render_context_render(render_context_, params);
        glFlush();
        gl_bind_framebuffer_(kGlFramebuffer, 0);
        const BOOL unlocked =
          wgl_dx_unlock_objects_(gl_interop_device_, 1, &gl_interop_object);
        if (!unlocked && render_result >= 0) render_result = -1;
        if (render_result >= 0) {
          device_context_->CopyResource(texture.Get(), gl_texture.Get());
          device_context_->Flush();
        }
      } else {
        const size_t stride = static_cast<size_t>(width) * 4;
        pixels_.resize(stride * height);
        int size[] = {static_cast<int>(width), static_cast<int>(height)};
        const char* format = "bgra";
        mpv_render_param params[] = {
          {MPV_RENDER_PARAM_SW_SIZE, size},
          {MPV_RENDER_PARAM_SW_FORMAT, const_cast<char*>(format)},
          {MPV_RENDER_PARAM_SW_STRIDE, const_cast<size_t*>(&stride)},
          {MPV_RENDER_PARAM_SW_POINTER, pixels_.data()},
          {MPV_RENDER_PARAM_INVALID, nullptr},
        };
        render_result = api_.render_context_render(render_context_, params);
        if (render_result >= 0) {
          // Some libswscale paths leave alpha undefined even for BGRA.
          auto* opaque_pixels = reinterpret_cast<uint32_t*>(pixels_.data());
          const size_t pixel_count = pixels_.size() / sizeof(uint32_t);
          for (size_t index = 0; index < pixel_count; ++index) {
            opaque_pixels[index] |= 0xff000000u;
          }
          device_context_->UpdateSubresource(
            texture.Get(),
            0,
            nullptr,
            pixels_.data(),
            static_cast<UINT>(stride),
            0
          );
          device_context_->Flush();
        }
      }

      keyed_mutex->ReleaseSync(0);
      if (render_result < 0) {
        free_slot();
        EmitEvent({"error", false, 0, "libmpv could not render a video frame."});
        continue;
      }
      if (FAILED(device_->GetDeviceRemovedReason())) {
        {
          std::scoped_lock lock(slot_mutex_);
          auto& slot = slots_[selected];
          slot.state = SlotState::kFree;
          ResetSlotLocked(slot);
        }
        graphics_recovery_requested_ = 1;
        RequestRender();
        continue;
      }
      {
        std::scoped_lock lock(slot_mutex_);
        slots_[selected].state = SlotState::kExported;
      }

      auto* frame = new SharedFrame{
        selected,
        reinterpret_cast<uint64_t>(shared_handle),
        width,
        height,
        ++sequence_,
      };
      const auto status = frame_callback_.NonBlockingCall(
        frame,
        [](Napi::Env env, Napi::Function callback, SharedFrame* data) {
          auto value = Napi::Object::New(env);
          value.Set("slot", Napi::Number::New(env, data->slot));
          value.Set("handle", Napi::BigInt::New(env, data->handle));
          value.Set("width", Napi::Number::New(env, data->width));
          value.Set("height", Napi::Number::New(env, data->height));
          value.Set("sequence", Napi::Number::New(env, static_cast<double>(data->sequence)));
          callback.Call({value});
          delete data;
        }
      );
      if (status != napi_ok) {
        delete frame;
        {
          std::scoped_lock lock(slot_mutex_);
          slots_[selected].state = SlotState::kFree;
        }
        RequestRender();
      }
    }
    if (use_open_gl_) wglMakeCurrent(nullptr, nullptr);
  }

  void EventLoop() {
    while (running_ && mpv_) {
      const mpv_event* event = api_.wait_event(mpv_, 0.1);
      if (!event || event->event_id == MPV_EVENT_NONE) continue;
      switch (event->event_id) {
        case MPV_EVENT_FILE_LOADED:
        case MPV_EVENT_PLAYBACK_RESTART:
          EmitEvent({"playing"});
          break;
        case MPV_EVENT_END_FILE: {
          // Ending by error must be distinguishable from an intentional stop:
          // the host suppresses "stopped" during in-place stream switches and
          // would otherwise hide genuine open/playback failures.
          const auto* end = static_cast<const mpv_event_end_file*>(event->data);
          if (end && end->reason == MPV_END_FILE_REASON_ERROR) {
            const char* description =
              api_.error_string ? api_.error_string(end->error) : "playback error";
            EmitEvent({
              "error",
              false,
              0,
              std::string("The stream ended unexpectedly: ") + description + ".",
            });
          } else {
            EmitEvent({"stopped"});
          }
          break;
        }
        case MPV_EVENT_PROPERTY_CHANGE: {
          const auto* property = static_cast<mpv_event_property*>(event->data);
          if (!property || !property->data) break;
          if (property->format == MPV_FORMAT_FLAG) {
            EmitEvent({
              property->name ? property->name : "property",
              *static_cast<int*>(property->data) != 0,
            });
          } else if (property->format == MPV_FORMAT_DOUBLE) {
            EmitEvent({
              property->name ? property->name : "property",
              false,
              *static_cast<double*>(property->data),
            });
          }
          break;
        }
        case MPV_EVENT_SHUTDOWN:
          return;
        default:
          break;
      }
    }
  }

  void EmitEvent(PlayerEvent event) {
    auto* payload = new PlayerEvent(std::move(event));
    const auto status = event_callback_.NonBlockingCall(
      payload,
      [](Napi::Env env, Napi::Function callback, PlayerEvent* data) {
        auto value = Napi::Object::New(env);
        value.Set("type", data->type);
        if (data->type == "pause" || data->type == "mute") value.Set("value", data->boolean_value);
        if (data->type == "volume") value.Set("value", data->number_value);
        if (!data->text.empty()) value.Set("message", data->text);
        callback.Call({value});
        delete data;
      }
    );
    if (status != napi_ok) delete payload;
  }

  void Stop() {
    const bool was_running = running_.exchange(false);
    render_condition_.notify_all();
    if (mpv_ && was_running) {
      const char* command[] = {"quit", nullptr};
      api_.command_async(mpv_, 0, command);
    }
    if (render_thread_.joinable()) render_thread_.join();
    if (event_thread_.joinable()) event_thread_.join();
    if (use_open_gl_ && gl_context_ && gl_dc_) {
      wglMakeCurrent(gl_dc_, gl_context_);
    }
    if (render_context_) {
      api_.render_context_set_update_callback(render_context_, nullptr, nullptr);
      api_.render_context_free(render_context_);
      render_context_ = nullptr;
    }
    if (mpv_) {
      api_.terminate_destroy(mpv_);
      mpv_ = nullptr;
    }
    {
      std::scoped_lock lock(slot_mutex_);
      ResetSlotsLocked();
    }
    DestroyOpenGlRenderer();
    pixels_.clear();
    device_context_.Reset();
    device_.Reset();
    render_requested_ = false;
    graphics_recovery_requested_ = 0;
    if (was_running) EmitEvent({"idle"});
  }

  HMODULE module_ = nullptr;
  MpvApi api_;
  mpv_handle* mpv_ = nullptr;
  mpv_render_context* render_context_ = nullptr;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> device_context_;
  HWND gl_window_ = nullptr;
  HDC gl_dc_ = nullptr;
  HGLRC gl_context_ = nullptr;
  HANDLE gl_interop_device_ = nullptr;
  bool use_open_gl_ = false;
  std::string open_gl_failure_;
  GlGenFramebuffers gl_gen_framebuffers_ = nullptr;
  GlDeleteFramebuffers gl_delete_framebuffers_ = nullptr;
  GlBindFramebuffer gl_bind_framebuffer_ = nullptr;
  GlCheckFramebufferStatus gl_check_framebuffer_status_ = nullptr;
  GlFramebufferRenderbuffer gl_framebuffer_renderbuffer_ = nullptr;
  GlGenRenderbuffers gl_gen_renderbuffers_ = nullptr;
  GlDeleteRenderbuffers gl_delete_renderbuffers_ = nullptr;
  WglDxOpenDeviceNv wgl_dx_open_device_ = nullptr;
  WglDxCloseDeviceNv wgl_dx_close_device_ = nullptr;
  WglDxRegisterObjectNv wgl_dx_register_object_ = nullptr;
  WglDxUnregisterObjectNv wgl_dx_unregister_object_ = nullptr;
  WglDxLockObjectsNv wgl_dx_lock_objects_ = nullptr;
  WglDxUnlockObjectsNv wgl_dx_unlock_objects_ = nullptr;
  std::array<Slot, 3> slots_;
  std::mutex slot_mutex_;
  std::vector<uint8_t> pixels_;
  std::atomic<uint32_t> width_{1280};
  std::atomic<uint32_t> height_{720};
  std::atomic<bool> running_{false};
  std::atomic<bool> render_requested_{false};
  std::atomic<int> graphics_recovery_requested_{0};
  std::atomic<uint64_t> sequence_{0};
  uint32_t adapter_index_ = 0;
  uint32_t preferred_vendor_id_ = 0;
  uint32_t preferred_device_id_ = 0;
  uint64_t device_generation_ = 0;
  std::thread render_thread_;
  std::thread event_thread_;
  std::mutex render_mutex_;
  std::condition_variable render_condition_;
  Napi::ThreadSafeFunction frame_callback_;
  Napi::ThreadSafeFunction event_callback_;
};

Napi::Object Initialize(Napi::Env env, Napi::Object exports) {
  exports.Set("TexturePlayer", TexturePlayer::Define(env));
  return exports;
}

NODE_API_MODULE(violetwire_texture_player, Initialize)

}  // namespace
