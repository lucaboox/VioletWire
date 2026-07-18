{
  "targets": [
    {
      "target_name": "violetwire_texture_player",
      "sources": ["src/texture_player.cpp"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../../vendor/native/mpv-dev/include"
      ],
      "defines": ["NAPI_CPP_EXCEPTIONS"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++20", "/EHsc"],
          "ExceptionHandling": 1
        }
      },
      "libraries": ["d3d11.lib", "dxgi.lib", "opengl32.lib", "gdi32.lib", "user32.lib"]
    }
  ]
}
