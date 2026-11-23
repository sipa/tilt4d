# Builds the single-file version of the demo (see tools/bundle.mjs).
#
#   make                          writes dist/tilt4d.html
#   make OUT=public/index.html    writes it somewhere else
#   make clean                    removes it
#
# The file is rebuilt only when something it is made from has changed.  The
# first run fetches the tools (esbuild) with npm.

OUT ?= dist/tilt4d.html

# Everything that goes into the file: the page, its stylesheet and every
# script, all the scenes included (and the licence, which the file carries).
SOURCES := index.html style.css $(wildcard src/*.js src/scenes/*.js)

.PHONY: all clean

all: $(OUT)

$(OUT): $(SOURCES) LICENSE tools/bundle.mjs tools/minify-shaders.mjs node_modules/.package-lock.json
	node tools/bundle.mjs --out $@

# (npm writes this file whenever it installs)
node_modules/.package-lock.json: package.json package-lock.json
	npm install
	@touch $@

clean:
	rm -f $(OUT)
	@rmdir $(dir $(OUT)) 2>/dev/null || true
