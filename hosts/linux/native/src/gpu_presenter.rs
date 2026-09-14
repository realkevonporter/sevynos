use raw_window_handle::{RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle, WaylandWindowHandle};
use smithay_client_toolkit::shell::{xdg::window::Window, WaylandSurface};
use std::{io, ptr::NonNull};
use wayland_client::{Connection, Proxy};

const SHADER: &str = r#"
@group(0) @binding(0) var frame_texture: texture_2d<f32>;
@group(0) @binding(1) var frame_sampler: sampler;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0)
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, 1.0), vec2<f32>(2.0, 1.0), vec2<f32>(0.0, -1.0)
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@fragment
fn fragment(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(frame_texture, frame_sampler, input.uv);
}
"#;

pub struct GpuPresenter {
    surface: wgpu::Surface<'static>,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    format: wgpu::TextureFormat,
    pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    configured: Option<(u32, u32)>,
}

impl GpuPresenter {
    pub fn new(connection: &Connection, window: &Window) -> io::Result<Self> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
            ..Default::default()
        });
        let display = NonNull::new(connection.backend().display_ptr() as *mut _)
            .ok_or_else(|| io::Error::other("Wayland display pointer is null"))?;
        let surface_ptr = NonNull::new(window.wl_surface().id().as_ptr() as *mut _)
            .ok_or_else(|| io::Error::other("Wayland surface pointer is null"))?;
        let surface = unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: RawDisplayHandle::Wayland(WaylandDisplayHandle::new(display)),
                raw_window_handle: RawWindowHandle::Wayland(WaylandWindowHandle::new(surface_ptr)),
            })
        }
        .map_err(io::Error::other)?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .ok_or_else(|| io::Error::other("No compatible GPU adapter"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("SevynOS GPU device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults(),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .map_err(io::Error::other)?;
        let capabilities = surface.get_capabilities(&adapter);
        let format = capabilities.formats.iter().copied().find(|f| f.is_srgb())
            .unwrap_or(capabilities.formats[0]);
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("SevynOS frame layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }, count: None },
                wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("SevynOS frame pipeline layout"), bind_group_layouts: &[&bind_group_layout], push_constant_ranges: &[] });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("SevynOS frame shader"), source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("SevynOS GPU frame pipeline"), layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vertex"), compilation_options: Default::default(), buffers: &[] },
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fragment"), compilation_options: Default::default(), targets: &[Some(wgpu::ColorTargetState { format, blend: Some(wgpu::BlendState::REPLACE), write_mask: wgpu::ColorWrites::ALL })] }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview: None, cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor { label: Some("SevynOS frame sampler"), mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        Ok(Self { surface, adapter, device, queue, format, pipeline, bind_group_layout, sampler, configured: None })
    }

    pub fn present(&mut self, rgba: &[u8], width: u32, height: u32) -> io::Result<()> {
        if self.configured != Some((width, height)) {
            let caps = self.surface.get_capabilities(&self.adapter);
            self.surface.configure(&self.device, &wgpu::SurfaceConfiguration {
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format: self.format, width, height,
                present_mode: if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) { wgpu::PresentMode::Mailbox } else { wgpu::PresentMode::Fifo },
                alpha_mode: caps.alpha_modes[0], view_formats: vec![self.format], desired_maximum_frame_latency: 2,
            });
            self.configured = Some((width, height));
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor { label: Some("SevynOS RGBA frame"), size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8UnormSrgb, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[] });
        self.queue.write_texture(wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All }, rgba, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(width * 4), rows_per_image: Some(height) }, wgpu::Extent3d { width, height, depth_or_array_layers: 1 });
        let texture_view = texture.create_view(&Default::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("SevynOS frame bindings"), layout: &self.bind_group_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&texture_view) }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) }] });
        let output = self.surface.get_current_texture().map_err(io::Error::other)?;
        let view = output.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        { let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("SevynOS GPU present"), color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None }); pass.set_pipeline(&self.pipeline); pass.set_bind_group(0, &bind_group, &[]); pass.draw(0..3, 0..1); }
        self.queue.submit(Some(encoder.finish()));
        output.present();
        Ok(())
    }
}
