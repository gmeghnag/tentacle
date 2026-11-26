# JPEG fixtures (docs/feat/image-region-jpeg.md, § Tests)

Made 2026-11-26 by INDEPENDENT encoders, never by tentacle code, from the
top-left of the public-domain photo
`20200801_021532_things_places_IMG_7364.jpg` (Wikimedia Commons, **CC0**,
iPhone X, 4032×3024, 2 801 647 bytes,
https://commons.wikimedia.org/wiki/File:20200801_021532_things_places_IMG_7364.jpg),
downscaled to 64×48 by Bun.Image (Bun 1.4.3):

- `small-baseline.jpg`, `small-progressive.jpg`: Bun.Image JPEG encoder, q92, 4:2:0 (SOF0 / SOF2).
- `small-gray.jpg` (1 component), `small-444.jpg` (4:4:4), `small-rgb-colorspace.jpg`
  (components R,G,B, no YCbCr transform): mozjpeg via `@jsquash/jpeg` 1.6.0 (scratch only, not a dependency), q92, baseline.
- `small-orient-N.jpg` (N = 1…8): `small-baseline.jpg` with an APP1 Exif segment
  (big-endian TIFF, IFD0 holding only Orientation = N) inserted after SOI; the
  scan data is byte-identical to `small-baseline.jpg`.

sha256:

- `small-baseline.jpg` 758952059d47b2585131b6444a8fb8e9cea529617c02ca513f2a49c1408155c1
- `small-progressive.jpg` b4143d5a332e4e760392956955722c1d07c2bc50d559ac452c0de2213f63cf6c
- `small-gray.jpg` 30df11e29de086fe6d712ab6a1d9a1f707e6ee7f1aa05283ef5017f7d10fcb55
- `small-444.jpg` c4b0f103874e48d4518888eb3a05393ab9199be8f42755cf9b3afebb809da7b5
- `small-rgb-colorspace.jpg` c2c0e07e979270bdb6a0af246c3d5a6620838a8e58e15e105f1bd888b174e0c6
- `small-orient-1.jpg` 16e075bb71c8f4ee089a35cb391e49c129d37de3eb6ea0222a6a335d905190be
- `small-orient-2.jpg` 3874ed8d9409a89bfa829597c0ef089c2e90e625a36220ea82aaf9cc1ff3a45a
- `small-orient-3.jpg` 9aae99a2b322f69dcceb18d2d8a6ff3bf259c32641995899fe773d1195e0deae
- `small-orient-4.jpg` 1ecce7f9def6b26b20b5eea63ce61a672cbf1d2c87d0bde93b65777f6fe080c3
- `small-orient-5.jpg` c0d33a3b55c647e4a1b2ed861ea6282afd1e1a41c058f11491e6344826e6780f
- `small-orient-6.jpg` 11e5cc3a8a8a0fbe1c53698af74ddb94358cb8578ce842561f9ba038ec0479c2
- `small-orient-7.jpg` a5e0e10d711a83f8e1a500859a5c27f7299bd8184af2055dc76cb27be3e0efef
- `small-orient-8.jpg` 3af47b72c14d285014a954bc798365b90960f4a544e839c8794557f1fb2b987b
