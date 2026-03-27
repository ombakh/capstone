import sys
import math
import time
import threading
import numpy as np

from rplidar import RPLidar
from PyQt5 import QtWidgets, QtCore
import pyqtgraph as pg


# ================== AYARLAR ==================
PORT = "/dev/ttyUSB0"
MAX_DIST = 6000
PLOT_UPDATE_MS = 50
# ============================================


# ================== LIDAR THREAD ==================
class LidarWorker(threading.Thread):
    def __init__(self, lidar):
        super().__init__(daemon=True)
        self.lidar = lidar
        self.points = []
        self._stop_flag = False

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
    def __init__(self):
        super().__init__()

        self.setWindowTitle("RPLIDAR A1M8 – Stable Live Viewer")
        self.resize(900, 900)

        # -------- Plot --------
        self.plot = pg.PlotWidget()
        self.setCentralWidget(self.plot)
        self.plot.setBackground("k")
        self.plot.setAspectLocked(True)
        self.plot.setXRange(-MAX_DIST, MAX_DIST)
        self.plot.setYRange(-MAX_DIST, MAX_DIST)
        self.plot.showGrid(x=True, y=True)

        self.scatter = pg.ScatterPlotItem(
            size=4,
            pen=None,
            brush=pg.mkBrush(0, 255, 0)
        )
        self.plot.addItem(self.scatter)

        # -------- LIDAR --------
        self.lidar = RPLidar(PORT)
        self.worker = None

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
            self.worker = None
            self.lidar.stop()
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
        if self.worker and self.worker.points:
            pts = np.array(self.worker.points)
            if pts.ndim == 2 and pts.shape[1] == 2:
                self.scatter.setData(x=pts[:, 0], y=pts[:, 1])

    # ---------- KEYBOARD ----------
    def keyPressEvent(self, event):
        key = event.key()

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

    # ---------- CLOSE ----------
    def closeEvent(self, event):
        self.stop_scan()
        self.lidar.stop_motor()
        self.lidar.disconnect()
        event.accept()
# ================================================


# ================== MAIN ==================
if __name__ == "__main__":
    app = QtWidgets.QApplication(sys.argv)
    win = LidarGUI()
    win.show()
    sys.exit(app.exec_())
# =========================================