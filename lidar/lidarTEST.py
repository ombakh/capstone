import sys
import argparse
import math
import time
import threading
import numpy as np

from PyQt5 import QtWidgets, QtCore, QtGui
import pyqtgraph as pg


# ================== AYARLAR ==================
PORT = "/dev/ttyUSB0"
MAX_DIST = 6000
SIM_UPDATE_HZ = 40.0
SIM_STEP_S = 1.0 / SIM_UPDATE_HZ
PLOT_UPDATE_MS = int(1000.0 / SIM_UPDATE_HZ)
# ============================================


def wrap_angle_rad(theta):
    return (theta + math.pi) % (2.0 * math.pi) - math.pi


def angle_diff_deg(a, b):
    return ((a - b + 180.0) % 360.0) - 180.0


class SimulatedLidar:
    """Drop-in replacement for RPLidar with room + moving robot simulation."""
    def __init__(self, max_dist=MAX_DIST, samples_per_scan=720):
        self.max_dist = max_dist
        self.samples_per_scan = samples_per_scan
        self._stop_flag = False
        self._motor_running = False

        # World units are millimeters.
        self.room_min_x = -3600.0
        self.room_max_x = 3600.0
        self.room_min_y = -2600.0
        self.room_max_y = 2600.0

        # Furniture / obstacles in a living-room-like space.
        self._segments = []
        self._static_circles = []
        self._build_environment()

        # Path followed by the robotic car (center of vehicle).
        self._waypoints = [
            (-2600.0, -1700.0),
            (-2000.0, 1500.0),
            (-200.0, 1900.0),
            (2200.0, 1500.0),
            (2700.0, -200.0),
            (1500.0, -1800.0),
            (-400.0, -2000.0),
        ]
        self._wp_index = 0
        self.car_x = self._waypoints[0][0]
        self.car_y = self._waypoints[0][1]
        self.car_yaw = math.radians(20.0)
        self._dyn_phase = 0.0
        self._rng = np.random.default_rng()
        self._manual_control = {
            "up": False,
            "down": False,
            "left": False,
            "right": False,
        }

        # A1-like sensor model (approximate).
        self._min_range_mm = 150.0
        self._max_range_mm = float(self.max_dist)
        self._nominal_spin_hz = 5.5
        self._spin_hz = self._nominal_spin_hz
        self._scan_start_deg = 0.0
        self._nominal_sample_rate_hz = self.samples_per_scan * self._nominal_spin_hz

    def start_motor(self):
        self._motor_running = True

    def stop_motor(self):
        self._motor_running = False

    def stop(self):
        self._stop_flag = True

    def reset(self):
        self._stop_flag = False
        self._wp_index = 0
        self.car_x = self._waypoints[0][0]
        self.car_y = self._waypoints[0][1]
        self.car_yaw = math.radians(20.0)
        self._dyn_phase = 0.0
        self._spin_hz = self._nominal_spin_hz
        self._scan_start_deg = 0.0

    def disconnect(self):
        pass

    def set_manual_control(self, direction, pressed):
        if direction in self._manual_control:
            self._manual_control[direction] = bool(pressed)

    @staticmethod
    def _ray_segment_distance(px, py, dx, dy, x1, y1, x2, y2):
        sx = x2 - x1
        sy = y2 - y1
        denom = dx * sy - dy * sx
        if abs(denom) < 1e-9:
            return None

        qpx = x1 - px
        qpy = y1 - py
        t = (qpx * sy - qpy * sx) / denom
        u = (qpx * dy - qpy * dx) / denom
        if t >= 0.0 and 0.0 <= u <= 1.0:
            return t
        return None

    @staticmethod
    def _ray_circle_distance(px, py, dx, dy, cx, cy, radius):
        mx = px - cx
        my = py - cy
        b = mx * dx + my * dy
        c = mx * mx + my * my - radius * radius
        disc = b * b - c
        if disc < 0.0:
            return None

        s = math.sqrt(disc)
        t1 = -b - s
        if t1 >= 0.0:
            return t1
        t2 = -b + s
        if t2 >= 0.0:
            return t2
        return None

    def _add_box(self, cx, cy, w, h):
        x1 = cx - w / 2.0
        x2 = cx + w / 2.0
        y1 = cy - h / 2.0
        y2 = cy + h / 2.0
        self._segments.extend([
            (x1, y1, x2, y1),
            (x2, y1, x2, y2),
            (x2, y2, x1, y2),
            (x1, y2, x1, y1),
        ])

    def _build_environment(self):
        # Room boundary
        self._segments.extend([
            (self.room_min_x, self.room_min_y, self.room_max_x, self.room_min_y),
            (self.room_max_x, self.room_min_y, self.room_max_x, self.room_max_y),
            (self.room_max_x, self.room_max_y, self.room_min_x, self.room_max_y),
            (self.room_min_x, self.room_max_y, self.room_min_x, self.room_min_y),
        ])

        # Sofa, table, cabinet, and island.
        self._add_box(-2800.0, 1200.0, 1200.0, 700.0)
        self._add_box(-900.0, 300.0, 1100.0, 700.0)
        self._add_box(2900.0, 1500.0, 500.0, 1500.0)
        self._add_box(1800.0, -1300.0, 900.0, 900.0)

        # Two round obstacles (chair / plant stand).
        self._static_circles.extend([
            (700.0, 1500.0, 230.0),
            (-600.0, -1200.0, 190.0),
        ])

    def _dynamic_circles(self):
        # Person/pet-like moving obstacle.
        cx = 450.0 + 950.0 * math.cos(self._dyn_phase * 0.7)
        cy = -250.0 + 650.0 * math.sin(self._dyn_phase)
        return [(cx, cy, 160.0)]

    def _advance_vehicle(self, dt):
        throttle = float(self._manual_control["up"]) - float(self._manual_control["down"])
        steer = float(self._manual_control["left"]) - float(self._manual_control["right"])

        if throttle != 0.0 or steer != 0.0:
            turn_rate = 1.85
            speed = throttle * 620.0
            self.car_yaw = wrap_angle_rad(self.car_yaw + steer * turn_rate * dt)
            self.car_x += speed * math.cos(self.car_yaw) * dt
            self.car_y += speed * math.sin(self.car_yaw) * dt
            self.car_x = min(max(self.car_x, self.room_min_x + 140.0), self.room_max_x - 140.0)
            self.car_y = min(max(self.car_y, self.room_min_y + 140.0), self.room_max_y - 140.0)
            self._dyn_phase += dt
            return

        tx, ty = self._waypoints[self._wp_index]
        dx = tx - self.car_x
        dy = ty - self.car_y
        dist = math.hypot(dx, dy)
        if dist < 180.0:
            self._wp_index = (self._wp_index + 1) % len(self._waypoints)
            tx, ty = self._waypoints[self._wp_index]
            dx = tx - self.car_x
            dy = ty - self.car_y
            dist = math.hypot(dx, dy)

        target_heading = math.atan2(dy, dx)
        heading_err = wrap_angle_rad(target_heading - self.car_yaw)
        yaw_rate = max(-0.85, min(0.85, 1.7 * heading_err))
        self.car_yaw = wrap_angle_rad(self.car_yaw + yaw_rate * dt)

        speed = 520.0 if abs(heading_err) < 0.35 else 260.0
        if dist < 550.0:
            speed *= 0.6
        self.car_x += speed * math.cos(self.car_yaw) * dt
        self.car_y += speed * math.sin(self.car_yaw) * dt

        self._dyn_phase += dt

    def _generate_scan(self):
        self._advance_vehicle(dt=SIM_STEP_S)
        scan = []
        circles = list(self._static_circles)
        circles.extend(self._dynamic_circles())

        # Spin RPM and sample stream are not perfectly constant in low-cost units.
        spin_target = self._nominal_spin_hz + 0.20 * math.sin(self._dyn_phase * 0.35)
        self._spin_hz += 0.12 * (spin_target - self._spin_hz) + self._rng.normal(0.0, 0.015)
        self._spin_hz = float(np.clip(self._spin_hz, 4.9, 6.8))

        sample_rate_hz = self._nominal_sample_rate_hz
        sample_rate_hz += 180.0 * math.sin(self._dyn_phase * 0.85 + 0.8)
        sample_rate_hz += self._rng.normal(0.0, 55.0)
        samples_this_scan = int(np.clip(sample_rate_hz / self._spin_hz, 560, 1000))

        self._scan_start_deg = (self._scan_start_deg + 360.0 * self._spin_hz * SIM_STEP_S) % 360.0
        weak_sector_center = (self._scan_start_deg + 210.0 + 16.0 * math.sin(self._dyn_phase * 0.6)) % 360.0
        weak_sector_half_width = 2.2 + abs(self._rng.normal(0.0, 0.7))

        for i in range(samples_this_scan):
            angle = self._scan_start_deg + (i * 360.0) / samples_this_scan
            angle += self._rng.normal(0.0, 0.16)  # slight angle jitter
            angle %= 360.0
            theta = self.car_yaw + math.radians(angle)
            ray_dx = math.cos(theta)
            ray_dy = math.sin(theta)

            distance = float(self.max_dist)
            for x1, y1, x2, y2 in self._segments:
                d = self._ray_segment_distance(
                    self.car_x, self.car_y, ray_dx, ray_dy, x1, y1, x2, y2
                )
                if d is not None and d < distance:
                    distance = d

            for cx, cy, radius in circles:
                d = self._ray_circle_distance(self.car_x, self.car_y, ray_dx, ray_dy, cx, cy, radius)
                if d is not None and d < distance:
                    distance = d

            if distance >= self._max_range_mm or distance <= self._min_range_mm:
                continue

            dist_ratio = min(1.0, distance / self._max_range_mm)
            texture_factor = 0.5 + 0.5 * math.sin(math.radians(angle * 2.8) + self._dyn_phase * 0.9)
            dropout_prob = 0.006 + 0.028 * (dist_ratio ** 2) + 0.012 * texture_factor
            if abs(angle_diff_deg(angle, weak_sector_center)) < weak_sector_half_width:
                dropout_prob += 0.34
            if self._rng.random() < dropout_prob:
                continue

            sigma = 7.0 + 0.0025 * distance + 0.00000035 * (distance ** 2)
            measured = distance + self._rng.normal(-2.0, sigma)
            is_outlier = self._rng.random() < 0.004
            if is_outlier:
                measured += self._rng.normal(0.0, 220.0) + (180.0 if self._rng.random() < 0.5 else -180.0)

            measured = float(np.clip(round(measured), self._min_range_mm, self._max_range_mm - 5.0))

            quality = int(15 - 7.0 * dist_ratio - 4.0 * dropout_prob + self._rng.integers(-1, 2))
            if is_outlier:
                quality -= 4
            quality = int(max(1, min(15, quality)))
            scan.append((quality, float(angle), measured))

        return scan

    def iter_scans(self):
        self._stop_flag = False
        while not self._stop_flag:
            if not self._motor_running:
                time.sleep(SIM_STEP_S)
                continue
            yield self._generate_scan()
            time.sleep(SIM_STEP_S)


# ================== LIDAR THREAD ==================
class LidarWorker(threading.Thread):
    def __init__(self, lidar):
        super().__init__(daemon=True)
        self.lidar = lidar
        self.points = []
        self._stop_flag = False

    def stop(self):
        self._stop_flag = True
        # Nudge blocking iterators (both real and simulated backends).
        try:
            self.lidar.stop()
        except Exception:
            pass

    def run(self):
        while not self._stop_flag:
            try:

                for scan in self.lidar.iter_scans():
                    if self._stop_flag:
                        return

                    pts = []
                    for (_, angle, distance) in scan:
                        if distance > 0:
                            rad = math.radians(angle)
                            x = distance * math.cos(rad)
                            y = distance * math.sin(rad)
                            pts.append((x, y))

                    self.points = pts

            except Exception as e:

                print("LIDAR stream error (restarting scan loop):", e)
                time.sleep(0.1)   # UART sakinleşsin
                continue          # while → yeni iter_scans()

# ==================================================


# ================== GUI ==================
class LidarGUI(QtWidgets.QMainWindow):
    def __init__(self, lidar, simulated=False):
        super().__init__()
        self.simulated = simulated
        self._drag_offset = None

        self.setWindowTitle("RPLIDAR A1M8 – Stable Live Viewer")
        self.resize(620, 620)
        self.setAttribute(QtCore.Qt.WA_TranslucentBackground, True)
        self.setWindowFlags(
            QtCore.Qt.FramelessWindowHint
            | QtCore.Qt.WindowStaysOnTopHint
            | QtCore.Qt.Tool
        )
        self.setWindowOpacity(0.96)

        # -------- Plot --------
        pg.setConfigOptions(antialias=True)
        self.plot = pg.PlotWidget()
        self.setCentralWidget(self.plot)
        self.plot.setBackground((3, 18, 16))
        self.plot.setAspectLocked(True)
        self.plot.setXRange(-MAX_DIST, MAX_DIST)
        self.plot.setYRange(-MAX_DIST, MAX_DIST)
        self.plot.showGrid(x=False, y=False)
        self.plot.hideAxis("left")
        self.plot.hideAxis("bottom")
        self.plot.setMenuEnabled(False)
        self.plot.hideButtons()
        self.plot.setMouseEnabled(x=False, y=False)
        self.plot.setContentsMargins(8, 8, 8, 8)

        theta = np.linspace(0.0, 2.0 * math.pi, 220)
        ring_color = (102, 255, 194, 68)
        for frac in (0.2, 0.4, 0.6, 0.8, 1.0):
            r = MAX_DIST * frac
            ring = pg.PlotCurveItem(
                r * np.cos(theta),
                r * np.sin(theta),
                pen=pg.mkPen(*ring_color, width=1),
            )
            ring.setZValue(-15)
            self.plot.addItem(ring)

        cross_pen = pg.mkPen(85, 220, 170, 55, width=1)
        cross_x = pg.PlotCurveItem(x=[-MAX_DIST, MAX_DIST], y=[0.0, 0.0], pen=cross_pen)
        cross_y = pg.PlotCurveItem(x=[0.0, 0.0], y=[-MAX_DIST, MAX_DIST], pen=cross_pen)
        cross_x.setZValue(-14)
        cross_y.setZValue(-14)
        self.plot.addItem(cross_x)
        self.plot.addItem(cross_y)

        self.sweep_angle_deg = 90.0
        self.sweep_deg_per_s = 115.0
        self.sweep_trails = []
        for idx in range(8):
            alpha = max(18, 160 - idx * 18)
            width = 2 if idx == 0 else 1
            sweep_item = pg.PlotCurveItem(
                x=[],
                y=[],
                pen=pg.mkPen(130, 255, 190, alpha, width=width)
            )
            sweep_item.setZValue(-10 + idx)
            self.plot.addItem(sweep_item)
            self.sweep_trails.append(sweep_item)

        self.scatter = pg.ScatterPlotItem(
            size=4,
            pen=pg.mkPen(175, 255, 212, 90),
            brush=pg.mkBrush(108, 255, 186, 170)
        )
        self.scatter.setZValue(5)
        self.plot.addItem(self.scatter)

        self.robot_glow = pg.ScatterPlotItem(
            size=28,
            pen=None,
            brush=pg.mkBrush(108, 255, 186, 48)
        )
        self.robot_marker = pg.ScatterPlotItem(
            size=12,
            pen=pg.mkPen(182, 255, 220, width=2),
            brush=pg.mkBrush(56, 238, 166, 245)
        )
        self.robot_core = pg.ScatterPlotItem(
            size=4,
            pen=None,
            brush=pg.mkBrush(235, 255, 245, 235)
        )
        self.robot_glow.setData(x=[0.0], y=[0.0])
        self.robot_marker.setData(x=[0.0], y=[0.0])
        self.robot_core.setData(x=[0.0], y=[0.0])
        self.robot_glow.setZValue(12)
        self.robot_marker.setZValue(13)
        self.robot_core.setZValue(14)
        self.plot.addItem(self.robot_glow)
        self.plot.addItem(self.robot_marker)
        self.plot.addItem(self.robot_core)

        # -------- LIDAR --------
        self.lidar = lidar
        self.worker = None

        if not self.simulated:
            self.safe_init()

        # -------- GUI Timer --------
        self.timer = QtCore.QTimer()
        self.timer.timeout.connect(self.update_plot)
        self.timer.start(PLOT_UPDATE_MS)

        print("\nControls:")
        print("  S → Start scan")
        print("  P → Stop scan")
        print("  M → Stop motor")
        print("  R → HARD reset")
        print("  Q / ESC → Quit\n")
        print("Overlay: drag with left mouse button to move window\n")
        print("Sonar view: axes hidden, sweep beam enabled\n")
        if self.simulated:
            print("Running in SIMULATION mode (no physical sensor required)\n")
            print("Map stabilization: robot heading locked to north/up\n")
            print("Simulation controls: Arrow keys to drive (up/down + left/right)\n")
            self.start_scan()

    # ---------- LIDAR INIT ----------
    def safe_init(self):
        self.lidar.stop()
        self.lidar.stop_motor()
        time.sleep(1)
        self.lidar.reset()
        time.sleep(2)

    # ---------- SCAN CONTROL ----------
    def start_scan(self):
        if self.worker is None or not self.worker.is_alive():
            self.lidar.start_motor()
            self.worker = LidarWorker(self.lidar)
            self.worker.start()
            print("Scan started")

    def stop_scan(self):
        if self.worker:
            self.worker.stop()
            self.worker.join(timeout=0.5)
            self.worker = None
            print("Scan stopped")

    def stop_motor(self):
        self.stop_scan()
        self.lidar.stop_motor()
        print("Motor stopped")

    def hard_reset(self):
        print("HARD reset")
        self.stop_scan()
        self.lidar.stop_motor()
        time.sleep(1)
        self.lidar.reset()
        time.sleep(2)
        self.start_scan()

    # ---------- PLOT UPDATE ----------
    def update_plot(self):
        step_deg = self.sweep_deg_per_s * (PLOT_UPDATE_MS / 1000.0)
        self.sweep_angle_deg = (self.sweep_angle_deg - step_deg) % 360.0
        for idx, sweep_item in enumerate(self.sweep_trails):
            trail_angle = self.sweep_angle_deg + idx * 8.0
            rad = math.radians(trail_angle)
            sweep_item.setData(
                x=[0.0, MAX_DIST * math.cos(rad)],
                y=[0.0, MAX_DIST * math.sin(rad)]
            )

        if self.worker and self.worker.points:
            pts = np.array(self.worker.points)
            if pts.ndim == 2 and pts.shape[1] == 2:
                if self.simulated:
                    # Keep the robot facing north (up) in view space.
                    pts = np.column_stack((-pts[:, 1], pts[:, 0]))
                self.scatter.setData(x=pts[:, 0], y=pts[:, 1])

    # ---------- KEYBOARD ----------
    def _set_sim_control(self, key, pressed):
        if not self.simulated:
            return False
        key_map = {
            QtCore.Qt.Key_Up: "up",
            QtCore.Qt.Key_Down: "down",
            QtCore.Qt.Key_Left: "left",
            QtCore.Qt.Key_Right: "right",
        }
        direction = key_map.get(key)
        if direction is None:
            return False
        if hasattr(self.lidar, "set_manual_control"):
            self.lidar.set_manual_control(direction, pressed)
        return True

    def keyPressEvent(self, event):
        key = event.key()
        if self._set_sim_control(key, True):
            event.accept()
            return

        if key == QtCore.Qt.Key_S:
            self.start_scan()
        elif key == QtCore.Qt.Key_P:
            self.stop_scan()
        elif key == QtCore.Qt.Key_M:
            self.stop_motor()
        elif key == QtCore.Qt.Key_R:
            self.hard_reset()
        elif key in (QtCore.Qt.Key_Q, QtCore.Qt.Key_Escape):
            self.close()
        else:
            super().keyPressEvent(event)

    def keyReleaseEvent(self, event):
        if event.isAutoRepeat():
            event.ignore()
            return
        if self._set_sim_control(event.key(), False):
            event.accept()
            return
        super().keyReleaseEvent(event)

    def resizeEvent(self, event):
        # Keep the app as a circular overlay.
        self.setMask(QtGui.QRegion(self.rect(), QtGui.QRegion.Ellipse))
        super().resizeEvent(event)

    def mousePressEvent(self, event):
        if event.button() == QtCore.Qt.LeftButton:
            self._drag_offset = event.globalPos() - self.frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._drag_offset is not None and (event.buttons() & QtCore.Qt.LeftButton):
            self.move(event.globalPos() - self._drag_offset)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == QtCore.Qt.LeftButton:
            self._drag_offset = None
            event.accept()
            return
        super().mouseReleaseEvent(event)

    # ---------- CLOSE ----------
    def closeEvent(self, event):
        self.stop_scan()
        self.lidar.stop_motor()
        self.lidar.disconnect()
        event.accept()
# ================================================


def parse_args():
    parser = argparse.ArgumentParser(description="RPLIDAR A1M8 Live Viewer")
    parser.add_argument(
        "--sim",
        action="store_true",
        help="Run with simulated data (no sensor needed)."
    )
    parser.add_argument(
        "--port",
        default=PORT,
        help=f"Serial port for physical lidar (default: {PORT})"
    )
    return parser.parse_args()


def create_lidar(args):
    if args.sim:
        return SimulatedLidar(), True

    try:
        from rplidar import RPLidar
        return RPLidar(args.port), False
    except Exception as e:
        print(f"Could not open lidar on {args.port}: {e}")
        print("Falling back to simulation mode.")
        return SimulatedLidar(), True


# ================== MAIN ==================
if __name__ == "__main__":
    args = parse_args()
    lidar, simulated = create_lidar(args)
    app = QtWidgets.QApplication(sys.argv)
    win = LidarGUI(lidar=lidar, simulated=simulated)
    win.show()
    sys.exit(app.exec_())
# =========================================
