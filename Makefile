ifneq (,$(wildcard ./.env))
include .env
export
endif

PORT ?= 8080
WEB_HOST ?= 127.0.0.1
BACKEND_HOST ?= 0.0.0.0
BACKEND_PORT ?= 3000
HOST_IP ?= $(or $(PC_IP),$(MAC_IP))
PI_DEVICE_ID ?= pi-01
PI_LIDAR_ENABLED ?= 1
PI_LIDAR_PORT ?=
PI_VENV_DIR ?= .venv
PI_GATEWAY_ENV = BACKEND_WS_BASE=ws://$(HOST_IP):$(BACKEND_PORT) PI_DEVICE_ID=$(PI_DEVICE_ID) LIDAR_ENABLED=$(PI_LIDAR_ENABLED)$(if $(strip $(PI_LIDAR_PORT)), LIDAR_SERIAL_PORT=$(PI_LIDAR_PORT),)
PI_WEBRTC_ENV = BACKEND_WS_BASE=ws://$(HOST_IP):$(BACKEND_PORT) PI_DEVICE_ID=$(PI_DEVICE_ID)

.PHONY: help serve check run backend-install backend-ensure backend-dev backend-start pc-setup pc-backend pc-web pc-start mac-setup mac-backend mac-web mac-start pi-install pi-setup pi-run pi-run-echo pi-run-esc pi-run-webrtc pi-connect-echo pi-connect-esc pi-connect-webrtc-echo pi-connect-webrtc-esc pi-backend-check pi-keys

help:
	@echo "Available targets:"
	@echo "  make serve  - Serve web app at http://$(WEB_HOST):$(PORT)"
	@echo "  make check  - Run JavaScript syntax check"
	@echo "  make run    - Run web server and backend together"
	@echo "  make backend-install - Install backend dependencies"
	@echo "  make backend-dev     - Run backend in watch mode"
	@echo "  make backend-start   - Run backend"
	@echo "  make pc-setup        - Install PC-side backend dependencies"
	@echo "  make pc-backend      - Run backend for a Pi to connect to"
	@echo "  make pc-web          - Serve the web app on this PC"
	@echo "  make pc-start        - Run backend and web app on this PC"
	@echo "  make pi-install      - Install Raspberry Pi gateway deps"
	@echo "  make pi-setup        - Install Raspberry Pi gateway deps"
	@echo "  make pi-run          - Run Raspberry Pi gateway"
	@echo "  make pi-run-echo     - Run Pi gateway in no-hardware echo mode"
	@echo "  make pi-run-esc      - Run Pi gateway with direct Pi GPIO ESC control"
	@echo "  make pi-run-webrtc   - Run the Pi WebRTC camera publisher"
	@echo "  make pi-connect-echo PC_IP=<ip> - Connect Pi echo mode to the PC backend with LiDAR streaming"
	@echo "  make pi-connect-esc  PC_IP=<ip> - Connect Pi ESC mode to the PC backend with LiDAR streaming"
	@echo "  make pi-connect-webrtc-echo PC_IP=<ip> - Connect Pi controls in echo mode and publish WebRTC video"
	@echo "  make pi-connect-webrtc-esc  PC_IP=<ip> - Connect Pi controls in ESC mode and publish WebRTC video"
	@echo "  make pi-backend-check PC_IP=<ip> - Check backend health from the Pi"
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

pc-setup: backend-install

pc-backend:
	BACKEND_HOST=$(BACKEND_HOST) BACKEND_PORT=$(BACKEND_PORT) $(MAKE) backend-start

pc-web:
	WEB_HOST=127.0.0.1 PORT=$(PORT) $(MAKE) serve

pc-start:
	@trap 'kill 0 >/dev/null 2>&1' INT TERM EXIT; \
	BACKEND_HOST=$(BACKEND_HOST) BACKEND_PORT=$(BACKEND_PORT) $(MAKE) backend-start & \
	WEB_HOST=127.0.0.1 PORT=$(PORT) $(MAKE) serve & \
	wait

mac-setup: pc-setup

mac-backend: pc-backend

mac-web: pc-web

mac-start: pc-start

pi-install:
	python3 -m pip install -r pi/requirements.txt

pi-setup: pi-install

pi-run:
	python3 pi/gateway.py

pi-run-echo:
	PI_MOTOR_DRIVER=echo python3 pi/gateway.py

pi-run-esc:
	PI_MOTOR_DRIVER=esc python3 pi/gateway.py

pi-run-webrtc:
	python3 pi/webrtc_publisher.py

pi-connect-echo:
	@if [ -z "$(HOST_IP)" ]; then \
		echo "Usage: make pi-connect-echo PC_IP=192.168.1.25"; \
		exit 1; \
	fi
	@if [ ! -f "$(PI_VENV_DIR)/bin/activate" ]; then \
		echo "Missing $(PI_VENV_DIR)/bin/activate. Run: python3 -m venv $(PI_VENV_DIR) && make pi-setup"; \
		exit 1; \
	fi
	@. "$(PI_VENV_DIR)/bin/activate"; \
	$(PI_GATEWAY_ENV) PI_MOTOR_DRIVER=echo python3 pi/gateway.py

pi-connect-esc:
	@if [ -z "$(HOST_IP)" ]; then \
		echo "Usage: make pi-connect-esc PC_IP=192.168.1.25"; \
		exit 1; \
	fi
	@if [ ! -f "$(PI_VENV_DIR)/bin/activate" ]; then \
		echo "Missing $(PI_VENV_DIR)/bin/activate. Run: python3 -m venv $(PI_VENV_DIR) && make pi-setup"; \
		exit 1; \
	fi
	@. "$(PI_VENV_DIR)/bin/activate"; \
	$(PI_GATEWAY_ENV) PI_MOTOR_DRIVER=esc python3 pi/gateway.py

pi-connect-webrtc-echo:
	@if [ -z "$(HOST_IP)" ]; then \
		echo "Usage: make pi-connect-webrtc-echo PC_IP=192.168.1.25"; \
		exit 1; \
	fi
	@if [ ! -f "$(PI_VENV_DIR)/bin/activate" ]; then \
		echo "Missing $(PI_VENV_DIR)/bin/activate. Run: python3 -m venv $(PI_VENV_DIR) && make pi-setup"; \
		exit 1; \
	fi
	@. "$(PI_VENV_DIR)/bin/activate"; \
	trap 'kill 0 >/dev/null 2>&1' INT TERM EXIT; \
	$(PI_GATEWAY_ENV) PI_MOTOR_DRIVER=echo PI_CAMERA_JPEG_ENABLED=0 python3 pi/gateway.py & \
	$(PI_WEBRTC_ENV) python3 pi/webrtc_publisher.py & \
	wait

pi-connect-webrtc-esc:
	@if [ -z "$(HOST_IP)" ]; then \
		echo "Usage: make pi-connect-webrtc-esc PC_IP=192.168.1.25"; \
		exit 1; \
	fi
	@if [ ! -f "$(PI_VENV_DIR)/bin/activate" ]; then \
		echo "Missing $(PI_VENV_DIR)/bin/activate. Run: python3 -m venv $(PI_VENV_DIR) && make pi-setup"; \
		exit 1; \
	fi
	@. "$(PI_VENV_DIR)/bin/activate"; \
	trap 'kill 0 >/dev/null 2>&1' INT TERM EXIT; \
	$(PI_GATEWAY_ENV) PI_MOTOR_DRIVER=esc PI_CAMERA_JPEG_ENABLED=0 python3 pi/gateway.py & \
	$(PI_WEBRTC_ENV) python3 pi/webrtc_publisher.py & \
	wait

pi-backend-check:
	@if [ -z "$(HOST_IP)" ]; then \
		echo "Usage: make pi-backend-check PC_IP=192.168.1.25"; \
		exit 1; \
	fi
	curl --fail --show-error --silent "http://$(HOST_IP):$(BACKEND_PORT)/health"

pi-keys:
	python3 pi/arrow_serial_bridge.py
