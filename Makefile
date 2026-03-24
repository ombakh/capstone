ifneq (,$(wildcard ./.env))
include .env
export
endif

PORT ?= 8080
WEB_HOST ?= 127.0.0.1

.PHONY: help serve check run backend-install backend-ensure backend-dev backend-start pi-install pi-run pi-run-echo pi-keys

help:
	@echo "Available targets:"
	@echo "  make serve  - Serve web app at http://$(WEB_HOST):$(PORT)"
	@echo "  make check  - Run JavaScript syntax check"
	@echo "  make run    - Run web server and backend together"
	@echo "  make backend-install - Install backend dependencies"
	@echo "  make backend-dev     - Run backend in watch mode"
	@echo "  make backend-start   - Run backend"
	@echo "  make pi-install      - Install Raspberry Pi gateway deps"
	@echo "  make pi-run          - Run Raspberry Pi gateway"
	@echo "  make pi-run-echo     - Run Pi gateway in no-hardware echo mode"
	@echo "  make pi-keys         - Run keyboard-to-ESP serial bridge"
	@echo "  make help   - Show this help message"

serve:
	python3 -m http.server $(PORT) --bind $(WEB_HOST) --directory web

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

pi-install:
	python3 -m pip install -r pi/requirements.txt

pi-run:
	python3 pi/gateway.py

pi-run-echo:
	PI_MOTOR_ECHO_ONLY=1 python3 pi/gateway.py

pi-keys:
	python3 pi/arrow_serial_bridge.py
