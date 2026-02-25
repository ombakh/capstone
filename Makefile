ifneq (,$(wildcard ./.env))
include .env
export
endif

PORT ?= 8080

.PHONY: help serve check run backend-install backend-ensure backend-dev backend-start

help:
	@echo "Available targets:"
	@echo "  make serve  - Serve web app at http://localhost:$(PORT)"
	@echo "  make check  - Run JavaScript syntax check"
	@echo "  make run    - Run web server and backend together"
	@echo "  make backend-install - Install backend dependencies"
	@echo "  make backend-dev     - Run backend in watch mode"
	@echo "  make backend-start   - Run backend"
	@echo "  make help   - Show this help message"

serve:
	python3 -m http.server $(PORT) --directory web

check:
	node --check web/app.js

run:
	@trap 'kill 0 >/dev/null 2>&1' INT TERM EXIT; \
	$(MAKE) backend-dev & \
	$(MAKE) serve & \
	wait

backend-install:
	cd backend && npm install

backend-ensure:
	@if [ ! -d backend/node_modules/cors ] || [ ! -d backend/node_modules/express ] || [ ! -d backend/node_modules/ws ] || [ ! -d backend/node_modules/dotenv ]; then \
		echo "backend dependencies missing; running npm install..."; \
		$(MAKE) backend-install; \
	fi

backend-dev: backend-ensure
	cd backend && npm run dev

backend-start: backend-ensure
	cd backend && npm start
