# Bundled caption fonts

These `.ttf` files back the Shards caption **font list** (see
`src/pipeline/captions/fonts.ts`). At render time libass is pointed here via
`ass=…:fontsdir=…`, so captions render identically on any machine without the
fonts being installed system-wide.

Each file was instanced/normalized so its **regular weight is the heavy display
design** and its family name is unique — this makes libass matching
deterministic (reference the family with bold off and you always get this exact
file). The glyph outlines are unmodified; only the name table and OS/2 weight
metadata were rewritten.

| File | libass family | Display | License | Copyright |
|------|---------------|---------|---------|-----------|
| `Anton.ttf` | `Anton` | Anton | OFL-1.1 | 2020 The Anton Project Authors |
| `BebasNeue.ttf` | `Bebas Neue` | Bebas Neue | OFL-1.1 | 2019 The Bebas Neue Project Authors |
| `MontserratBlack.ttf` | `Montserrat Black` | Montserrat | OFL-1.1 | 2011 The Montserrat Project Authors |
| `PoppinsExtraBold.ttf` | `Poppins ExtraBold` | Poppins | OFL-1.1 | 2020 The Poppins Project Authors |
| `ArchivoBlack.ttf` | `Archivo Black` | Archivo Black | OFL-1.1 | 2017 The Archivo Black Project Authors |
| `LeagueSpartanBlack.ttf` | `League Spartan Black` | League Spartan | OFL-1.1 | 2020 The League Spartan Project Authors |
| `RobotoBlack.ttf` | `Roboto Black` | Roboto | Apache-2.0 | 2015 Google Inc. |
| `InterBlack.ttf` | `Inter Black` | Inter | OFL-1.1 | 2016 The Inter Project Authors |

All fonts are free for commercial use. Sourced from Google Fonts / the upstream
project repositories.

- **OFL-1.1** fonts: see [`OFL.txt`](./OFL.txt) (SIL Open Font License 1.1). Each
  font's copyright notice is listed above.
- **Apache-2.0** (Roboto): see [`LICENSE-Apache-2.0.txt`](./LICENSE-Apache-2.0.txt).

Montserrat, League Spartan, and Inter were instanced to their Black (900) weight
from the upstream variable fonts; the others ship as single-weight statics.
