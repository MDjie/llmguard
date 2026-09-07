from __future__ import annotations

import argparse
from pathlib import Path

import pypdfium2 as pdfium


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=150)
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    document = pdfium.PdfDocument(args.pdf)
    scale = args.dpi / 72
    for index in range(len(document)):
        page = document[index]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        image.save(args.output_dir / f"page-{index + 1}.png")
        image.close()
        bitmap.close()
        page.close()
    print(f"Rendered {len(document)} pages")


if __name__ == "__main__":
    main()
