#version 140

in mediump vec2 var_texcoord0;
out vec4 out_fragColor;

uniform mediump sampler2D texture_sampler;
uniform fs_uniforms
{
    mediump vec4 tint;
    highp vec4 time;
};

void main()
{
    vec4 pixel = texture(texture_sampler, var_texcoord0);
    // The generator tags only ocean pixels with alpha 252/255. This avoids
    // animating dark cliff shadows or the transparent interior by color guess.
    if (pixel.a > 0.97 && pixel.a < 0.995)
    {
        // A short, one-source-pixel foam dash crosses a wave row on each
        // quarter-second tick. The previous four-pixel diagonal cell pattern
        // amplified into a checkerboard at gameplay camera zoom.
        vec2 texel = floor(var_texcoord0 * vec2(1536.0, 800.0));
        float phase = floor(time.x * 4.0);
        float row = mod(texel.y + phase + floor(texel.x / 48.0) * 3.0, 31.0);
        float segment = mod(texel.x + floor(texel.y / 31.0) * 17.0, 47.0);
        float foam = (1.0 - step(1.0, row)) * (1.0 - step(12.0, segment));
        pixel.rgb += foam * vec3(0.025, 0.040, 0.040);
        pixel.a = 1.0;
    }
    vec4 tint_pm = vec4(tint.xyz * tint.w, tint.w);
    out_fragColor = pixel * tint_pm;
}
