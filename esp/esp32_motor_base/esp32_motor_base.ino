/*
  ESP32 motor-control base for Capstone

  Serial protocol (line-delimited JSON from Raspberry Pi):
    {"type":"command","id":"...","command":"drive","params":{"direction":"forward","speed":0.6}}
    {"type":"command","id":"...","command":"stop","params":{}}
    {"type":"command","id":"...","command":"set_speed","params":{"speed":0.5}}

  Serial telemetry emitted by this sketch:
    {"type":"telemetry","direction":"forward","speed":0.6,"uptime_ms":1234}
    {"type":"ack","commandId":"...","status":"ok","detail":"drive_applied"}

  Requires ArduinoJson library.
*/

#include <ArduinoJson.h>

// Update these pins for your motor driver wiring.
const int MOTOR_LEFT_IN1 = 16;
const int MOTOR_LEFT_IN2 = 17;
const int MOTOR_RIGHT_IN1 = 18;
const int MOTOR_RIGHT_IN2 = 19;

String serialBuffer = "";
String currentDirection = "stop";
float currentSpeed = 0.0f;
unsigned long lastTelemetryMs = 0;

void setMotorPins(bool leftForward, bool leftReverse, bool rightForward, bool rightReverse) {
  digitalWrite(MOTOR_LEFT_IN1, leftForward ? HIGH : LOW);
  digitalWrite(MOTOR_LEFT_IN2, leftReverse ? HIGH : LOW);
  digitalWrite(MOTOR_RIGHT_IN1, rightForward ? HIGH : LOW);
  digitalWrite(MOTOR_RIGHT_IN2, rightReverse ? HIGH : LOW);
}

void applyDrive(const String &direction, float speed) {
  currentDirection = direction;
  currentSpeed = constrain(speed, 0.0f, 1.0f);

  if (direction == "forward") {
    setMotorPins(true, false, true, false);
    return;
  }
  if (direction == "reverse") {
    setMotorPins(false, true, false, true);
    return;
  }
  if (direction == "left") {
    setMotorPins(false, true, true, false);
    return;
  }
  if (direction == "right") {
    setMotorPins(true, false, false, true);
    return;
  }

  // Default/fallback: stop.
  currentDirection = "stop";
  currentSpeed = 0.0f;
  setMotorPins(false, false, false, false);
}

void emitJson(const JsonDocument &doc) {
  serializeJson(doc, Serial);
  Serial.println();
}

void sendAck(const String &commandId, const String &status, const String &detail) {
  StaticJsonDocument<192> doc;
  doc["type"] = "ack";
  doc["commandId"] = commandId;
  doc["status"] = status;
  doc["detail"] = detail;
  doc["uptime_ms"] = millis();
  emitJson(doc);
}

void sendTelemetry() {
  StaticJsonDocument<192> doc;
  doc["type"] = "telemetry";
  doc["direction"] = currentDirection;
  doc["speed"] = currentSpeed;
  doc["uptime_ms"] = millis();
  emitJson(doc);
}

void handleCommandLine(const String &line) {
  StaticJsonDocument<384> doc;
  DeserializationError error = deserializeJson(doc, line);
  if (error) {
    sendAck("", "invalid_json", "deserialize_failed");
    return;
  }

  const String envelopeType = doc["type"] | "";
  const String commandId = doc["id"] | "";
  const String commandName = doc["command"] | "";
  JsonVariant params = doc["params"];

  if (envelopeType != "command") {
    sendAck(commandId, "ignored", "unsupported_envelope");
    return;
  }

  float speed = 0.55f;
  if (!params.isNull()) {
    speed = params["speed"] | speed;
  }
  speed = constrain(speed, 0.0f, 1.0f);

  if (commandName == "drive") {
    String direction = "stop";
    if (!params.isNull()) {
      direction = String((const char *)(params["direction"] | "stop"));
    }
    direction.toLowerCase();
    applyDrive(direction, speed);
    sendAck(commandId, "ok", "drive_applied");
    return;
  }

  if (commandName == "stop") {
    applyDrive("stop", 0.0f);
    sendAck(commandId, "ok", "stopped");
    return;
  }

  if (commandName == "set_speed") {
    currentSpeed = speed;
    sendAck(commandId, "ok", "speed_updated");
    return;
  }

  sendAck(commandId, "ignored", "unsupported_command");
}

void setup() {
  pinMode(MOTOR_LEFT_IN1, OUTPUT);
  pinMode(MOTOR_LEFT_IN2, OUTPUT);
  pinMode(MOTOR_RIGHT_IN1, OUTPUT);
  pinMode(MOTOR_RIGHT_IN2, OUTPUT);
  setMotorPins(false, false, false, false);

  Serial.begin(115200);
  delay(150);
  sendAck("", "ready", "esp32_motor_base_online");
}

void loop() {
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    if (c == '\n') {
      String line = serialBuffer;
      serialBuffer = "";
      line.trim();
      if (line.length() > 0) {
        handleCommandLine(line);
      }
    } else if (c != '\r') {
      serialBuffer += c;
    }
  }

  if (millis() - lastTelemetryMs >= 1000) {
    lastTelemetryMs = millis();
    sendTelemetry();
  }
}
