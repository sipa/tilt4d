# Builds the single-file version of the demo (see tools/bundle.mjs), and puts
# a copy of preview.jpg next to it: the picture that a link to the page shows
# where it is posted, which is the one thing a web server needs besides the
# file.
#
#   make                          writes dist/index.html and dist/preview.jpg
#   make OUT=public/index.html    writes them somewhere else
#   make clean                    removes them
#
# Each is made again only when something it is made from has changed.  The
# first run fetches the tools (esbuild) with npm.

OUT ?= dist/index.html

# The copy of the picture.  (Not where the file is written next to the picture
# itself, as with OUT=tilt4d.html: there is nothing to copy then, and nothing
# of it for `make clean` to remove.)
PREVIEW := $(dir $(OUT))preview.jpg
ifeq ($(abspath $(PREVIEW)),$(abspath preview.jpg))
PREVIEW :=
endif

# Everything that goes into the file: the page, its stylesheet and every
# script, all the scenes included (and the licence, which the file carries).
SOURCES := index.html style.css $(wildcard src/*.js src/scenes/*.js)

.PHONY: all clean

all: $(OUT) $(PREVIEW)

$(OUT): $(SOURCES) LICENSE tools/bundle.mjs tools/minify-shaders.mjs node_modules/.package-lock.json
	node tools/bundle.mjs --out $@

# (npm writes this file whenever it installs)
node_modules/.package-lock.json: package.json package-lock.json
	npm install
	@touch $@

ifneq ($(PREVIEW),)
$(PREVIEW): preview.jpg
	@mkdir -p $(dir $@)
	cp $< $@
endif

clean:
	rm -f $(OUT) $(PREVIEW)
	@rmdir $(dir $(OUT)) 2>/dev/null || true
