# folio

A static site generator for photography portfolios, built on Astro. Galleries
are folders of images plus a short YAML file. The defaults are tuned for black
and white work.

## Quick start

```sh
npm ci
npm run fetch-example   # public-domain sample photos for example/
npm run dev             # http://localhost:4321, live reload on content edits
npm run build           # static site in dist/
```

`FOLIO_CONTENT` selects the content directory (default `example/`),
`FOLIO_CACHE` the image cache (default `.cache/`).

## Content

```
content/
  site.yaml
  about.md
  galleries/
    <slug>/
      gallery.yaml
      *.jpg
```

### site.yaml

```yaml
title: Name Surname
galleries:            # navigation order; only listed galleries are built
  - nubian-village
  - ferry
pages: [about.md]     # Markdown, optional `title:` front matter
footer: All photographs (c) Name Surname
defaults:             # optional, overridable per gallery
  theme: light        # light | dark
  view: sequence      # sequence | grid
  border: none        # none | hairline
images:
  max: 2560           # longest edge of the largest published derivative
```

A gallery folder that is not listed in `galleries` is not built and none of its
images are published. The dev server shows such galleries as drafts.

### gallery.yaml

Each level adds keys; nothing changes meaning between levels.

Level 0, show the folder in filename order:

```yaml
title: Worthington, Ohio
```

Level 1, choose and order images, with captions:

```yaml
title: China, 1946
images:
  - junk.jpg: Junk on the river
  - boat.jpg: Boat on a river
  - mother.jpg
```

Level 2, structured captions and per-image options:

```yaml
title: Ferry
year: 1979
intro: |
  Markdown shown before the first image and above the index.
view: grid
theme: dark
border: hairline
cover: 02.jpg
images:
  - 01.jpg:
      title: Ferry Slip, Jersey City
      year: 1979
      medium: Gelatin silver print
      size: 40 x 50 cm
      caption: Free text
      alt: Text for screen readers
      border: none
```

Without a caption in the config, an image's embedded XMP/IPTC title and
description (as written by digiKam, Lightroom and similar) are used. EXIF
ImageDescription is ignored; scanners and cameras fill it with noise.

Errors name the file and line:

```
galleries/ferry/gallery.yaml:7:5: image not found: 03.jpg
```

## Images

Each source image is analysed once and cached by content hash:

- Derivatives at long edges 480 to `images.max`, never larger than the source,
  as AVIF and JPEG, served with `srcset` so browsers fetch what the layout needs.
- Images without visible chroma are converted to greyscale (single-channel
  JPEG), which rules out colour casts. Scans of toned prints keep their colour.
- Originals are never published.

## Deployment

```sh
FOLIO_CONTENT=/path/to/content docker compose run --rm build
docker compose up -d web          # Caddy on port 8080 (FOLIO_PORT)
```

The build container writes each build into a new release directory and
switches a `current` symlink once it is complete. The image cache persists in a
volume, so rebuilds only process new or changed images.

## Tests

```sh
npm test                  # loader tests; browser tests if dist/ exists
CHROMIUM=/usr/bin/chromium npm test   # use a system browser
```

The browser tests step through every image of the built site at viewports from
375x667 to 3440x1440 and check that image and caption are fully visible, nothing
overflows horizontally and no image is upscaled.
