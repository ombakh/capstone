ifneq (,$(wildcard ./.env))
include .env
export
endif

PORT ?= 8080

.PHONY: help serve check backend-install backend-dev backend-start

help:
	@echo "Available targets:"
	@echo "  make serve  - Serve web app at http://localhost:$(PORT)"
	@echo "  make check  - Run JavaScript syntax check"
	@echo "  make backend-install - Install backend dependencies"
	@echo "  make backend-dev     - Run backend in watch mode"
	@echo "  make backend-start   - Run backend"
	@echo "  make help   - Show this help message"

serve:
	python3 -m http.server $(PORT) --directory web

check:
	node --check web/app.js

backend-install:
	cd backend && npm install

backend-dev:
	cd backend && npm run dev

backend-start:
	cd backend && npm start
