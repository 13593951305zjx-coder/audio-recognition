"""Render the local Audio Insight opening clip and its poster frame."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont


WIDTH, HEIGHT = 960, 540
FPS = 30
DURATION = 4.8
WEB = Path(__file__).resolve().parents[1] / "audio_llm_backend" / "web"
VIDEO = WEB / "intro.mp4"
POSTER = WEB / "intro-poster.jpg"
FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_NORMAL = "C:/Windows/Fonts/msyh.ttc"


def smoothstep(a: float, b: float, value: float) -> float:
    x = min(1.0, max(0.0, (value - a) / (b - a)))
    return x * x * (3 - 2 * x)


def base_image() -> Image.Image:
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH]
    cyan = np.exp(-(((xx - 160) / 430) ** 2 + ((yy - 210) / 390) ** 2))
    violet = np.exp(-(((xx - 800) / 380) ** 2 + ((yy - 360) / 330) ** 2))
    rgb = np.stack(
        [6 + 8 * cyan + 27 * violet, 11 + 23 * cyan + 10 * violet, 26 + 35 * cyan + 42 * violet],
        axis=-1,
    ).clip(0, 255).astype("uint8")
    img = Image.fromarray(rgb, "RGB").convert("RGBA")
    grid_layer = Image.new("RGBA", (WIDTH, HEIGHT))
    grid = ImageDraw.Draw(grid_layer, "RGBA")
    for x in range(0, WIDTH, 34):
        grid.line((x, 0, x, HEIGHT), fill=(148, 163, 184, 9), width=1)
    for y in range(0, HEIGHT, 34):
        grid.line((0, y, WIDTH, y), fill=(148, 163, 184, 9), width=1)
    return Image.alpha_composite(img, grid_layer)


BASE = base_image()
F_TITLE = ImageFont.truetype(FONT_BOLD, 56)
F_EN = ImageFont.truetype(FONT_BOLD, 19)
F_SMALL = ImageFont.truetype(FONT_NORMAL, 20)
F_CHIP = ImageFont.truetype(FONT_NORMAL, 18)


def frame_at(t: float) -> Image.Image:
    frame = BASE.copy()
    overlay = Image.new("RGBA", (WIDTH, HEIGHT))
    ink = ImageDraw.Draw(overlay, "RGBA")
    reveal = smoothstep(0.10, 0.86, t)
    text_reveal = smoothstep(0.62, 1.50, t)
    chip_reveal = smoothstep(2.25, 3.05, t)
    fade_out = 1 - smoothstep(4.50, 4.80, t)

    # A restrained sound waveform ties the clip to the cover's live audio graphic.
    wave_alpha = int(205 * smoothstep(0.25, 1.15, t) * fade_out)
    for i in range(55):
        x = 108 + i * 14
        envelope = 0.35 + 0.65 * (math.sin(i * 0.21) ** 2)
        motion = 0.58 + 0.42 * math.sin(t * 5.4 + i * 0.62)
        bar_height = 10 + int(62 * envelope * motion)
        color = (75, 218, 238, wave_alpha) if i < 29 else (169, 121, 248, wave_alpha)
        ink.rounded_rectangle((x, 402 - bar_height / 2, x + 6, 402 + bar_height / 2), radius=3, fill=color)

    # Logo and title arrive in sequence; all text is rendered into the video itself.
    a = int(255 * reveal * fade_out)
    ink.rounded_rectangle((74, 62, 304, 103), radius=20, fill=(29, 79, 104, int(135 * reveal * fade_out)), outline=(59, 212, 232, int(100 * reveal * fade_out)), width=1)
    ink.ellipse((90, 75, 102, 87), fill=(87, 226, 239, a))
    ink.text((115, 69), "AUDIO INSIGHT", font=F_EN, fill=(129, 235, 244, a))

    title_alpha = int(255 * text_reveal * fade_out)
    rise = int(18 * (1 - text_reveal))
    ink.text((76, 153 + rise), "智能音频识别与", font=F_TITLE, fill=(244, 250, 255, title_alpha))
    ink.text((76, 225 + rise), "重要信息提取系统", font=F_TITLE, fill=(173, 211, 255, title_alpha))
    ink.rounded_rectangle((77, 315, 624, 318), radius=1, fill=(89, 215, 237, int(195 * text_reveal * fade_out)))
    ink.text((77, 334), "本地 Whisper 转写  ·  Qwen 重点提取  ·  音高分析", font=F_SMALL, fill=(165, 185, 215, int(240 * text_reveal * fade_out)))

    for x, label, color in (
        (77, "语音转写", (77, 212, 235)),
        (222, "重点提取", (180, 133, 249)),
        (367, "音高统计", (76, 207, 165)),
    ):
        chip_alpha = int(220 * chip_reveal * fade_out)
        ink.rounded_rectangle((x, 456, x + 125, 497), radius=12, fill=(*color, int(35 * chip_reveal * fade_out)), outline=(*color, int(95 * chip_reveal * fade_out)), width=1)
        ink.text((x + 21, 464), label, font=F_CHIP, fill=(245, 250, 255, chip_alpha))

    ink.text((774, 475), "LOCAL AI", font=F_EN, fill=(124, 145, 177, int(140 * chip_reveal * fade_out)))
    return Image.alpha_composite(frame, overlay).convert("RGB")


def main() -> None:
    WEB.mkdir(parents=True, exist_ok=True)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS), "-i", "-",
        "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "22",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(VIDEO),
    ]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    try:
        for number in range(round(DURATION * FPS)):
            image = frame_at(number / FPS)
            if number == round(3.8 * FPS):
                image.save(POSTER, quality=90)
            assert process.stdin is not None
            process.stdin.write(image.tobytes())
    finally:
        if process.stdin:
            process.stdin.close()
    if process.wait() != 0:
        raise RuntimeError("FFmpeg failed to render the startup clip")
    print(VIDEO)
    print(POSTER)


if __name__ == "__main__":
    main()
