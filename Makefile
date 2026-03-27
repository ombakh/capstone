ifneq (,$(wildcard ./.env))
include .env
export
endif

PORT ?= 8080
WEB_HOST ?= 127.0.0.1
BACKEND_HOST ?= 0.0.0.0
BACKEND_PORT ?= 3000
PI_DEVICE_ID ?= pi-01
PI_LIDAR_ENABLED ?= 1
PI_LIDAR_PORT ?= /dev/ttyUSB0

.PHONY: help serve check run backend-install backend-ensure backend-dev backend-start mac-setup mac-backend mac-web mac-start pi-install pi-setup pi-run pi-run-echo pi-connect-echo pi-keys

help:
	@echo "Available targets:"
	@echo "  make serve  - Serve web app at http://$(WEB_HOST):$(PORT)"
	@echo "  make check  - Run JavaScript syntax check"
	@echo "  make run    - Run web server and backend together"
	@echo "  make backend-install - Install backend dependencies"
	@echo "  make backend-dev     - Run backend in watch mode"
	@echo "  make backend-start   - Run backend"
	@echo "  make mac-setup       - Install Mac-side backend dependencies"
	@echo "  make mac-backend     - Run backend for a Pi to connect to"
	@echo "  make mac-web         - Serve the web app on this Mac"
	@echo "  make mac-start       - Run backend and web app on this Mac"
	@echo "  make pi-install      - Install Raspberry Pi gateway deps"
	@echo "  make pi-setup        - Install Raspberry Pi gateway deps"
	@echo "  make pi-run          - Run Raspberry Pi gateway"
	@echo "  make pi-run-echo     - Run Pi gateway in no-hardware echo mode"
	@echo "  make pi-connect-echo MAC_IP=<ip> - Connect Pi echo mode to the Mac backend with LiDAR streaming"
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

mac-setup: backend-install

mac-backend:
	BACKEND_HOST=$(BACKEND_HOST) BACKEND_PORT=$(BACKEND_PORT) $(MAKE) backend-start

mac-web:
	WEB_HOST=127.0.0.1 PORT=$(PORT) $(MAKE) serve

mac-start:
	@trap 'kill 0 >/dev/null 2>&1' INT TERM EXIT; \
	BACKEND_HOST=$(BACKEND_HOST) BACKEND_PORT=$(BACKEND_PORT) $(MAKE) backend-start & \
	WEB_HOST=127.0.0.1 PORT=$(PORT) $(MAKE) serve & \
	wait

pi-install:
	python3 -m pip install -r pi/requirements.txt

pi-setup: pi-install

pi-run:
	python3 pi/gateway.py

pi-run-echo:
	PI_MOTOR_ECHO_ONLY=1 python3 pi/gateway.py

pi-connect-echo:
	@if [ -z "$(MAC_IP)" ]; then \
		echo "Usage: make pi-connect-echo MAC_IP=192.168.1.25"; \
		exit 1; \
	fi
	BACKEND_WS_BASE=ws://$(MAC_IP):$(BACKEND_PORT) PI_DEVICE_ID=$(PI_DEVICE_ID) LIDAR_ENABLED=$(PI_LIDAR_ENABLED) LIDAR_SERIAL_PORT=$(PI_LIDAR_PORT) PI_MOTOR_ECHO_ONLY=1 python3 pi/gateway.py

pi-keys:
	python3 pi/arrow_serial_bridge.py
