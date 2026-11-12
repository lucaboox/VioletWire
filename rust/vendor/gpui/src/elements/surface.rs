use crate::{
    App, Bounds, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement, LayoutId,
    ObjectFit, Pixels, Style, StyleRefinement, Styled, Window,
};
#[cfg(target_os = "macos")]
use core_video::pixel_buffer::CVPixelBuffer;
use refineable::Refineable;

/// A source of a surface's content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SurfaceSource {
    /// A GPU-resident BGRA texture on the window's Direct3D device.
    #[cfg(target_os = "windows")]
    Windows(WindowsSurface),
    /// A macOS image buffer from CoreVideo
    #[cfg(target_os = "macos")]
    Surface(CVPixelBuffer),
}

#[cfg(target_os = "macos")]
impl From<CVPixelBuffer> for SurfaceSource {
    fn from(value: CVPixelBuffer) -> Self {
        SurfaceSource::Surface(value)
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug, PartialEq, Eq)]
/// Shader-readable video texture retained directly on the render device.
pub struct WindowsSurface {
    pub(crate) texture: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
    pub(crate) view: windows::Win32::Graphics::Direct3D11::ID3D11ShaderResourceView,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[cfg(target_os = "windows")]
impl WindowsSurface {
    /// GPU destination for a decoder/video processor on the same device.
    pub fn texture(&self) -> &windows::Win32::Graphics::Direct3D11::ID3D11Texture2D { &self.texture }
    /// Whether this texture can still be drawn by the current window device.
    pub fn belongs_to(&self, device: &windows::Win32::Graphics::Direct3D11::ID3D11Device) -> bool {
        unsafe { self.texture.GetDevice().is_ok_and(|owner| owner == *device) }
    }
    /// Wraps a shader-readable BGRA texture without uploading or copying it.
    pub fn new(texture: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D) -> anyhow::Result<Self> {
        use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { texture.GetDesc(&mut desc) };
        anyhow::ensure!(desc.Format == DXGI_FORMAT_B8G8R8A8_UNORM && desc.ArraySize == 1 && desc.SampleDesc.Count == 1,
            "GPU surface requires a single-sample BGRA texture");
        let device = unsafe { texture.GetDevice()? };
        let mut view = None;
        unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut view))? };
        Ok(Self { texture, view: view.unwrap(), width: desc.Width, height: desc.Height })
    }
}
#[cfg(target_os = "windows")]
impl From<WindowsSurface> for SurfaceSource {
    fn from(value: WindowsSurface) -> Self { Self::Windows(value) }
}

/// A surface element.
pub struct Surface {
    source: SurfaceSource,
    object_fit: ObjectFit,
    style: StyleRefinement,
}

/// Create a new surface element.
pub fn surface(source: impl Into<SurfaceSource>) -> Surface {
    Surface {
        source: source.into(),
        object_fit: ObjectFit::Contain,
        style: Default::default(),
    }
}

impl Surface {
    /// Set the object fit for the image.
    pub fn object_fit(mut self, object_fit: ObjectFit) -> Self {
        self.object_fit = object_fit;
        self
    }
}

impl Element for Surface {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.refine(&self.style);
        let layout_id = window.request_layout(style, [], cx);
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
    }

    fn paint(
        &mut self,
        _global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] bounds: Bounds<Pixels>,
        _: &mut Self::RequestLayoutState,
        _: &mut Self::PrepaintState,
        #[cfg_attr(not(target_os = "macos"), allow(unused_variables))] window: &mut Window,
        _: &mut App,
    ) {
        match &self.source {
            #[cfg(target_os = "windows")]
            SurfaceSource::Windows(surface) => {
                let size = crate::size(crate::DevicePixels(surface.width as i32), crate::DevicePixels(surface.height as i32));
                window.paint_gpu_surface(self.object_fit.get_bounds(bounds, size), surface.clone());
            }
            #[cfg(target_os = "macos")]
            SurfaceSource::Surface(surface) => {
                let size = crate::size(surface.get_width().into(), surface.get_height().into());
                let new_bounds = self.object_fit.get_bounds(bounds, size);
                // TODO: Add support for corner_radii
                window.paint_surface(new_bounds, surface.clone());
            }
            #[allow(unreachable_patterns)]
            _ => {}
        }
    }
}

impl IntoElement for Surface {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Styled for Surface {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}
