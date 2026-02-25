ifneq (,$(wildcard ./.env))
include .env
export
endif

PORT ?= 8080

.PHONY: help serve check

help:
	@echo "Available targets:"
	@echo "  make serve  - Serve web app at http://localhost:$(PORT)"
	@echo "  make check  - Run JavaScript syntax check"
	@echo "  make help   - Show this help message"

serve:
	python3 -m http.server $(PORT) --directory web

check:
	node --check web/app.js
