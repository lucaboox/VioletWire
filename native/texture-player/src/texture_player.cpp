#include <napi.h>

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <mpv/client.h>
#include <mpv/render.h>

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

struct MpvApi {
  decltype(&mpv_create) create = nullptr;
  decltype(&mpv_initialize) initialize = nullptr;
  decltype(&mpv_set_option_string) set_option_string = nullptr;
  decltype(&mpv_observe_property) observe_property = nullptr;
  decltype(&mpv_command_async) command_async = nullptr;
  decltype(&mpv_wait_event) wait_event = nullptr;
  decltype(&mpv_terminate_destroy) terminate_destroy = nullptr;
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
  struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<IDXGIKeyedMutex> keyed_mutex;
    HANDLE handle = nullptr;
    bool busy = false;
  };

  bool LoadMpvApi() {
    return LoadFunction(module_, "mpv_create", api_.create) &&
      LoadFunction(module_, "mpv_initialize", api_.initialize) &&
      LoadFunction(module_, "mpv_set_option_string", api_.set_option_string) &&
      LoadFunction(module_, "mpv_observe_property", api_.observe_property) &&
      LoadFunction(module_, "mpv_command_async", api_.command_async) &&
      LoadFunction(module_, "mpv_wait_event", api_.wait_event) &&
      LoadFunction(module_, "mpv_terminate_destroy", api_.terminate_destroy) &&
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

    HRESULT result = D3D11CreateDevice(
      nullptr,
      D3D_DRIVER_TYPE_HARDWARE,
      nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr,
      0,
      D3D11_SDK_VERSION,
      &device_,
      nullptr,
      &device_context_
    );
    if (FAILED(result)) {
      throw Napi::Error::New(env, "D3D11 is unavailable for the embedded Native player.");
    }

    mpv_ = api_.create();
    if (!mpv_) throw Napi::Error::New(env, "libmpv could not create a playback context.");
    api_.set_option_string(mpv_, "vo", "libmpv");
    api_.set_option_string(mpv_, "terminal", "no");
    api_.set_option_string(mpv_, "input-default-bindings", "no");
    api_.set_option_string(mpv_, "osc", "no");
    api_.set_option_string(mpv_, "profile", "low-latency");
    // The initial bridge deliberately uses libmpv's stable software render API
    // and uploads into a D3D11 shared texture. auto-copy preserves hardware
    // decoding where the decoder can efficiently copy frames back.
    api_.set_option_string(mpv_, "hwdec", "auto-copy");
    api_.set_option_string(mpv_, "keep-open", "no");
    if (api_.initialize(mpv_) < 0) {
      Stop();
      throw Napi::Error::New(env, "libmpv could not initialize.");
    }

    const char* api_type = MPV_RENDER_API_TYPE_SW;
    mpv_render_param create_params[] = {
      {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(api_type)},
      {MPV_RENDER_PARAM_INVALID, nullptr},
    };
    if (api_.render_context_create(&render_context_, mpv_, create_params) < 0) {
      Stop();
      throw Napi::Error::New(
        env,
        "This libmpv build does not expose the software render API required by the prototype."
      );
    }

    api_.render_context_set_update_callback(render_context_, &TexturePlayer::OnRenderUpdate, this);
    api_.observe_property(mpv_, 1, "pause", MPV_FORMAT_FLAG);
    api_.observe_property(mpv_, 2, "mute", MPV_FORMAT_FLAG);
    api_.observe_property(mpv_, 3, "volume", MPV_FORMAT_DOUBLE);

    running_ = true;
    render_thread_ = std::thread(&TexturePlayer::RenderLoop, this);
    event_thread_ = std::thread(&TexturePlayer::EventLoop, this);

    const std::string url = info[0].As<Napi::String>().Utf8Value();
    const char* command[] = {"loadfile", url.c_str(), "replace", nullptr};
    api_.command_async(mpv_, 0, command);
    RequestRender();
    return env.Undefined();
  }

  Napi::Value Resize(const Napi::CallbackInfo& info) {
    if (info.Length() >= 2 && info[0].IsNumber() && info[1].IsNumber()) {
      const auto next_width = std::clamp(info[0].As<Napi::Number>().Uint32Value(), 320u, 3840u);
      const auto next_height = std::clamp(info[1].As<Napi::Number>().Uint32Value(), 180u, 2160u);
      if (next_width != width_ || next_height != height_) {
        std::scoped_lock lock(slot_mutex_);
        width_ = next_width;
        height_ = next_height;
        ResetSlotsLocked();
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

  Napi::Value ReleaseFrame(const Napi::CallbackInfo& info) {
    if (info.Length() >= 1 && info[0].IsNumber()) {
      const uint32_t index = info[0].As<Napi::Number>().Uint32Value();
      std::scoped_lock lock(slot_mutex_);
      if (index < slots_.size()) slots_[index].busy = false;
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

  bool EnsureSlotLocked(uint32_t index, uint32_t width, uint32_t height) {
    auto& slot = slots_[index];
    if (slot.texture) return true;

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
    return true;
  }

  void ResetSlotsLocked() {
    for (auto& slot : slots_) {
      if (slot.handle) CloseHandle(slot.handle);
      slot = {};
    }
  }

  void RenderLoop() {
    while (running_) {
      {
        std::unique_lock lock(render_mutex_);
        render_condition_.wait(lock, [this] { return !running_ || render_requested_.exchange(false); });
      }
      if (!running_ || !render_context_) continue;

      const uint64_t update_flags = api_.render_context_update(render_context_);
      if ((update_flags & MPV_RENDER_UPDATE_FRAME) == 0) continue;

      const uint32_t width = width_.load();
      const uint32_t height = height_.load();
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
      const int render_result = api_.render_context_render(render_context_, params);
      if (render_result < 0) {
        EmitEvent({"error", false, 0, "libmpv could not render a video frame."});
        continue;
      }
      // Electron imports this resource as an alpha-bearing BGRA texture.
      // Some libswscale paths leave alpha undefined even for BGRA output,
      // which Chromium correctly composites as a transparent black frame.
      for (size_t offset = 3; offset < pixels_.size(); offset += 4) {
        pixels_[offset] = 0xff;
      }

      uint32_t selected = static_cast<uint32_t>(slots_.size());
      HANDLE shared_handle = nullptr;
      {
        std::scoped_lock lock(slot_mutex_);
        for (uint32_t index = 0; index < slots_.size(); ++index) {
          if (!slots_[index].busy && EnsureSlotLocked(index, width, height)) {
            selected = index;
            break;
          }
        }
        if (selected == slots_.size()) continue;
        auto& slot = slots_[selected];
        slot.busy = true;
        shared_handle = slot.handle;
        const HRESULT acquire_result = slot.keyed_mutex->AcquireSync(0, 1'000);
        if (FAILED(acquire_result)) {
          slot.busy = false;
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
        device_context_->UpdateSubresource(
          slot.texture.Get(),
          0,
          nullptr,
          pixels_.data(),
          static_cast<UINT>(stride),
          0
        );
        device_context_->Flush();
        slot.keyed_mutex->ReleaseSync(0);
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
        std::scoped_lock lock(slot_mutex_);
        slots_[selected].busy = false;
      }
    }
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
        case MPV_EVENT_END_FILE:
          EmitEvent({"stopped"});
          break;
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
    pixels_.clear();
    device_context_.Reset();
    device_.Reset();
    render_requested_ = false;
    if (was_running) EmitEvent({"idle"});
  }

  HMODULE module_ = nullptr;
  MpvApi api_;
  mpv_handle* mpv_ = nullptr;
  mpv_render_context* render_context_ = nullptr;
  ComPtr<ID3D11Device> device_;
  ComPtr<ID3D11DeviceContext> device_context_;
  std::array<Slot, 3> slots_;
  std::mutex slot_mutex_;
  std::vector<uint8_t> pixels_;
  std::atomic<uint32_t> width_{1280};
  std::atomic<uint32_t> height_{720};
  std::atomic<bool> running_{false};
  std::atomic<bool> render_requested_{false};
  std::atomic<uint64_t> sequence_{0};
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
