#include <Arduino.h>
#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

// ESP32 ESC signal wiring. Override these with PlatformIO build_flags if your
// board layout uses different GPIOs.
#ifndef LEFT_ESC_PIN
#define LEFT_ESC_PIN 18
#endif

#ifndef RIGHT_ESC_PIN
#define RIGHT_ESC_PIN 19
#endif

#ifndef ESC_BIDIRECTIONAL
#define ESC_BIDIRECTIONAL 0
#endif

#ifndef ESC_LEFT_INVERTED
#define ESC_LEFT_INVERTED 0
#endif

#ifndef ESC_RIGHT_INVERTED
#define ESC_RIGHT_INVERTED 0
#endif

#ifndef ESC_ARM_PULSE_US
#define ESC_ARM_PULSE_US 1000
#endif

#ifndef ESC_NEUTRAL_PULSE_US
#define ESC_NEUTRAL_PULSE_US 1000
#endif

#ifndef ESC_FORWARD_MIN_PULSE_US
#define ESC_FORWARD_MIN_PULSE_US 1100
#endif

#ifndef ESC_FORWARD_MAX_PULSE_US
#define ESC_FORWARD_MAX_PULSE_US 2000
#endif

#ifndef ESC_REVERSE_MIN_PULSE_US
#define ESC_REVERSE_MIN_PULSE_US 1440
#endif

#ifndef ESC_REVERSE_MAX_PULSE_US
#define ESC_REVERSE_MAX_PULSE_US 1100
#endif

#ifndef ESC_ARM_DELAY_MS
#define ESC_ARM_DELAY_MS 3000
#endif

#ifndef ESC_WATCHDOG_TIMEOUT_MS
#define ESC_WATCHDOG_TIMEOUT_MS 3000
#endif

#ifndef ESC_MAX_SPEED
#define ESC_MAX_SPEED 0.15f
#endif

#ifndef ESC_RAMP_STEP_US
#define ESC_RAMP_STEP_US 8
#endif

#ifndef ESC_UPDATE_HZ
#define ESC_UPDATE_HZ 50
#endif

constexpr int kLeftEscPin = LEFT_ESC_PIN;
constexpr int kRightEscPin = RIGHT_ESC_PIN;
constexpr int kLeftEscChannel = 0;
constexpr int kRightEscChannel = 1;
constexpr int kServoFrequencyHz = 50;
constexpr int kPwmResolutionBits = 16;
constexpr uint32_t kPwmMaxDuty = (1UL << kPwmResolutionBits) - 1;
constexpr int kServoPeriodUs = 1000000 / kServoFrequencyHz;
constexpr int kMinPulseUs = 900;
constexpr int kMaxPulseUs = 2100;
constexpr bool kBidirectional = ESC_BIDIRECTIONAL != 0;
constexpr bool kLeftInverted = ESC_LEFT_INVERTED != 0;
constexpr bool kRightInverted = ESC_RIGHT_INVERTED != 0;
constexpr int kArmPulseUs = ESC_ARM_PULSE_US;
constexpr int kNeutralPulseUs = ESC_NEUTRAL_PULSE_US;
constexpr int kForwardMinPulseUs = ESC_FORWARD_MIN_PULSE_US;
constexpr int kForwardMaxPulseUs = ESC_FORWARD_MAX_PULSE_US;
constexpr int kReverseMinPulseUs = ESC_REVERSE_MIN_PULSE_US;
constexpr int kReverseMaxPulseUs = ESC_REVERSE_MAX_PULSE_US;
constexpr unsigned long kArmDelayMs = ESC_ARM_DELAY_MS;
constexpr unsigned long kWatchdogTimeoutMs = ESC_WATCHDOG_TIMEOUT_MS;
constexpr float kMaxSpeed = ESC_MAX_SPEED;
constexpr int kRampStepUs = ESC_RAMP_STEP_US;
constexpr unsigned long kUpdateIntervalMs = 1000UL / ESC_UPDATE_HZ;
constexpr unsigned long kStatusPublishIntervalMs = 1000;
constexpr unsigned long kDirtyStatusPublishIntervalMs = 250;
constexpr size_t kSerialLineBufferSize = 256;

enum class MotorState {
    Disarmed,
    Arming,
    Armed
};

char serialLineBuffer[kSerialLineBufferSize] = {0};
size_t serialLineLength = 0;
MotorState motorState = MotorState::Disarmed;
int currentLeftPulseUs = kNeutralPulseUs;
int currentRightPulseUs = kNeutralPulseUs;
int targetLeftPulseUs = kNeutralPulseUs;
int targetRightPulseUs = kNeutralPulseUs;
unsigned long armingCompleteAtMs = 0;
unsigned long commandDeadlineAtMs = 0;
unsigned long lastOutputUpdateMs = 0;
unsigned long lastStatusPublishMs = 0;
bool commandDeadlineActive = false;
bool statusDirty = true;
char activeDirection[12] = "stop";
char lastError[96] = "";

int clampInt(int value, int minimum, int maximum) {
    if (value < minimum) {
        return minimum;
    }
    if (value > maximum) {
        return maximum;
    }
    return value;
}

float clampFloat(float value, float minimum, float maximum) {
    if (value < minimum) {
        return minimum;
    }
    if (value > maximum) {
        return maximum;
    }
    return value;
}

int lerpInt(int start, int end, float ratio) {
    const float boundedRatio = clampFloat(ratio, 0.0f, 1.0f);
    return static_cast<int>(roundf(static_cast<float>(start) + static_cast<float>(end - start) * boundedRatio));
}

int moveTowards(int current, int target, int maximumStep) {
    if (current < target) {
        return min(target, current + maximumStep);
    }
    if (current > target) {
        return max(target, current - maximumStep);
    }
    return target;
}

void setLastError(const char *message) {
    if (message == nullptr || message[0] == '\0') {
        lastError[0] = '\0';
        return;
    }
    strncpy(lastError, message, sizeof(lastError) - 1);
    lastError[sizeof(lastError) - 1] = '\0';
}

void setActiveDirection(const char *direction) {
    strncpy(activeDirection, direction, sizeof(activeDirection) - 1);
    activeDirection[sizeof(activeDirection) - 1] = '\0';
}

uint32_t dutyForPulseUs(int pulseUs) {
    const int boundedPulseUs = clampInt(pulseUs, 0, kMaxPulseUs);
    return static_cast<uint32_t>((static_cast<uint64_t>(boundedPulseUs) * kPwmMaxDuty) / kServoPeriodUs);
}

void writeEscPulse(int channel, int pulseUs) {
    ledcWrite(channel, dutyForPulseUs(pulseUs));
}

void applyCurrentPulses() {
    writeEscPulse(kLeftEscChannel, currentLeftPulseUs);
    writeEscPulse(kRightEscChannel, currentRightPulseUs);
}

void forcePulses(int leftPulseUs, int rightPulseUs) {
    currentLeftPulseUs = clampInt(leftPulseUs, kMinPulseUs, kMaxPulseUs);
    currentRightPulseUs = clampInt(rightPulseUs, kMinPulseUs, kMaxPulseUs);
    targetLeftPulseUs = currentLeftPulseUs;
    targetRightPulseUs = currentRightPulseUs;
    applyCurrentPulses();
}

void setTargetPulses(int leftPulseUs, int rightPulseUs) {
    targetLeftPulseUs = clampInt(leftPulseUs, kMinPulseUs, kMaxPulseUs);
    targetRightPulseUs = clampInt(rightPulseUs, kMinPulseUs, kMaxPulseUs);
}

void writeJsonString(const char *value) {
    Serial.print('"');
    for (const char *cursor = value; cursor != nullptr && *cursor != '\0'; ++cursor) {
        const char ch = *cursor;
        if (ch == '"' || ch == '\\') {
            Serial.print('\\');
            Serial.print(ch);
        } else if (static_cast<unsigned char>(ch) < 0x20) {
            Serial.print(' ');
        } else {
            Serial.print(ch);
        }
    }
    Serial.print('"');
}

void publishAck(const char *id, const char *status, const char *command, const char *detailsJson = nullptr) {
    Serial.print("{\"type\":\"ack\",\"id\":");
    writeJsonString(id != nullptr ? id : "");
    Serial.print(",\"status\":");
    writeJsonString(status);
    Serial.print(",\"command\":");
    writeJsonString(command);
    if (detailsJson != nullptr && detailsJson[0] != '\0') {
        Serial.print(",\"details\":");
        Serial.print(detailsJson);
    }
    Serial.println("}");
}

bool isArming() {
    return motorState == MotorState::Arming;
}

bool isArmed() {
    return motorState == MotorState::Armed;
}

void publishMotorStatus(const char *reason = nullptr) {
    const bool arming = isArming();
    const bool armed = isArmed();
    const bool ready = armed && !arming;

    Serial.print("{\"type\":\"motor.status\",\"driver\":\"esp\",\"driverAvailable\":true");
    Serial.print(",\"requiresArm\":true");
    Serial.print(",\"armed\":");
    Serial.print(armed ? "true" : "false");
    Serial.print(",\"arming\":");
    Serial.print(arming ? "true" : "false");
    Serial.print(",\"readyForDrive\":");
    Serial.print(ready ? "true" : "false");
    Serial.print(",\"bidirectional\":");
    Serial.print(kBidirectional ? "true" : "false");
    Serial.print(",\"direction\":");
    writeJsonString(activeDirection);
    Serial.print(",\"maxSpeed\":");
    Serial.print(kMaxSpeed, 3);
    Serial.print(",\"watchdogTimeoutMs\":");
    Serial.print(kWatchdogTimeoutMs);
    Serial.print(",\"pins\":{\"leftSignalGpio\":");
    Serial.print(kLeftEscPin);
    Serial.print(",\"rightSignalGpio\":");
    Serial.print(kRightEscPin);
    Serial.print("},\"pulseWidthsUs\":{\"arm\":");
    Serial.print(kArmPulseUs);
    Serial.print(",\"neutral\":");
    Serial.print(kNeutralPulseUs);
    Serial.print(",\"forwardMin\":");
    Serial.print(kForwardMinPulseUs);
    Serial.print(",\"forwardMax\":");
    Serial.print(kForwardMaxPulseUs);
    Serial.print(",\"reverseMin\":");
    Serial.print(kReverseMinPulseUs);
    Serial.print(",\"reverseMax\":");
    Serial.print(kReverseMaxPulseUs);
    Serial.print(",\"currentLeft\":");
    Serial.print(currentLeftPulseUs);
    Serial.print(",\"currentRight\":");
    Serial.print(currentRightPulseUs);
    Serial.print(",\"targetLeft\":");
    Serial.print(targetLeftPulseUs);
    Serial.print(",\"targetRight\":");
    Serial.print(targetRightPulseUs);
    Serial.print("},\"signal\":{\"servoFrequencyHz\":");
    Serial.print(kServoFrequencyHz);
    Serial.print(",\"resolutionBits\":");
    Serial.print(kPwmResolutionBits);
    Serial.print(",\"rampStepUs\":");
    Serial.print(kRampStepUs);
    Serial.print("},\"lastError\":");
    if (lastError[0] == '\0') {
        Serial.print("null");
    } else {
        writeJsonString(lastError);
    }
    if (reason != nullptr && reason[0] != '\0') {
        Serial.print(",\"reason\":");
        writeJsonString(reason);
    }
    Serial.println("}");

    lastStatusPublishMs = millis();
    statusDirty = false;
}

void markStatusDirty() {
    statusDirty = true;
}

const char *findJsonKeyValueStart(const char *line, const char *key) {
    char pattern[32];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const size_t patternLength = strlen(pattern);
    const char *searchFrom = line;

    while (searchFrom != nullptr && *searchFrom != '\0') {
        const char *keyStart = strstr(searchFrom, pattern);
        if (keyStart == nullptr) {
            return nullptr;
        }

        const char *prefix = keyStart;
        while (prefix > line && isspace(static_cast<unsigned char>(prefix[-1]))) {
            --prefix;
        }

        const bool looksLikeObjectKey =
            prefix == line ||
            prefix[-1] == '{' ||
            prefix[-1] == ',';

        const char *cursor = keyStart + patternLength;
        while (*cursor != '\0' && isspace(static_cast<unsigned char>(*cursor))) {
            ++cursor;
        }

        if (looksLikeObjectKey && *cursor == ':') {
            ++cursor;
            while (*cursor != '\0' && isspace(static_cast<unsigned char>(*cursor))) {
                ++cursor;
            }
            return cursor;
        }

        searchFrom = keyStart + patternLength;
    }

    return nullptr;
}

bool extractJsonString(const char *line, const char *key, char *out, size_t outSize) {
    if (outSize == 0) {
        return false;
    }

    const char *cursor = findJsonKeyValueStart(line, key);
    if (cursor == nullptr || *cursor != '"') {
        return false;
    }
    ++cursor;

    size_t length = 0;
    while (*cursor != '\0' && *cursor != '"') {
        char ch = *cursor;
        if (ch == '\\' && cursor[1] != '\0') {
            ++cursor;
            ch = *cursor;
        }
        if (length < outSize - 1) {
            out[length++] = ch;
        }
        ++cursor;
    }
    out[length] = '\0';
    return *cursor == '"';
}

bool extractJsonFloat(const char *line, const char *key, float &out) {
    const char *cursor = findJsonKeyValueStart(line, key);
    if (cursor == nullptr) {
        return false;
    }

    char *end = nullptr;
    const float parsed = strtof(cursor, &end);
    if (end == cursor) {
        return false;
    }
    out = parsed;
    return true;
}

bool extractJsonInt(const char *line, const char *key, int &out) {
    const char *cursor = findJsonKeyValueStart(line, key);
    if (cursor == nullptr) {
        return false;
    }

    char *end = nullptr;
    const long parsed = strtol(cursor, &end, 10);
    if (end == cursor) {
        return false;
    }
    out = static_cast<int>(parsed);
    return true;
}

bool isDriveDirection(const char *direction) {
    return strcmp(direction, "forward") == 0 ||
           strcmp(direction, "reverse") == 0 ||
           strcmp(direction, "left") == 0 ||
           strcmp(direction, "right") == 0;
}

int pulseForSignedSpeed(float signedSpeed) {
    if (fabsf(signedSpeed) < 1e-6f) {
        return kNeutralPulseUs;
    }

    if (signedSpeed > 0.0f) {
        return lerpInt(kForwardMinPulseUs, kForwardMaxPulseUs, fabsf(signedSpeed));
    }

    if (!kBidirectional) {
        return kNeutralPulseUs;
    }

    return lerpInt(kReverseMinPulseUs, kReverseMaxPulseUs, fabsf(signedSpeed));
}

float signedSpeedForSide(const char *direction, bool leftSide, float speedRatio) {
    float signedSpeed = 0.0f;

    if (strcmp(direction, "forward") == 0) {
        signedSpeed = speedRatio;
    } else if (strcmp(direction, "reverse") == 0) {
        signedSpeed = kBidirectional ? -speedRatio : 0.0f;
    } else if (strcmp(direction, "left") == 0) {
        signedSpeed = (kBidirectional && leftSide) ? -speedRatio : (!leftSide ? speedRatio : 0.0f);
    } else if (strcmp(direction, "right") == 0) {
        signedSpeed = leftSide ? speedRatio : (kBidirectional ? -speedRatio : 0.0f);
    }

    const bool inverted = leftSide ? kLeftInverted : kRightInverted;
    if (inverted && !kBidirectional) {
        return signedSpeed;
    }
    return inverted ? -signedSpeed : signedSpeed;
}

void stopMotors(const char *reason) {
    commandDeadlineActive = false;
    setActiveDirection("stop");
    setTargetPulses(kNeutralPulseUs, kNeutralPulseUs);
    setLastError("");
    markStatusDirty();
    if (reason != nullptr && strcmp(reason, "watchdog_timeout") == 0) {
        publishMotorStatus(reason);
    }
}

void beginArm(const char *id) {
    motorState = MotorState::Arming;
    armingCompleteAtMs = millis() + kArmDelayMs;
    commandDeadlineActive = false;
    setActiveDirection("stop");
    setLastError("");
    forcePulses(kArmPulseUs, kArmPulseUs);
    publishAck(id, "arming_started", "arm_motors");
    publishMotorStatus("arming_started");
}

void disarmMotors(const char *id, const char *reason = "manual") {
    motorState = MotorState::Disarmed;
    armingCompleteAtMs = 0;
    commandDeadlineActive = false;
    setActiveDirection("stop");
    setLastError("");
    forcePulses(kNeutralPulseUs, kNeutralPulseUs);
    publishAck(id, "motor_disarmed", "disarm_motors");
    publishMotorStatus(reason);
}

void applyDriveCommand(const char *id, const char *direction, float requestedSpeed, int durationMs) {
    if (!isDriveDirection(direction)) {
        setLastError("invalid drive direction");
        publishAck(id, "invalid_drive_direction", "drive");
        publishMotorStatus("invalid_drive_direction");
        return;
    }

    if (isArming()) {
        publishAck(id, "motor_arming", "drive");
        return;
    }

    if (!isArmed()) {
        publishAck(id, "motor_not_armed", "drive");
        return;
    }

    if (strcmp(direction, "reverse") == 0 && !kBidirectional) {
        stopMotors("reverse_disabled");
        publishAck(id, "reverse_unsupported", "drive");
        return;
    }

    const float appliedSpeed = min(clampFloat(requestedSpeed, 0.0f, 1.0f), kMaxSpeed);
    if (appliedSpeed <= 0.0f) {
        stopMotors("zero_speed");
        return;
    }

    const int leftPulseUs = pulseForSignedSpeed(signedSpeedForSide(direction, true, appliedSpeed));
    const int rightPulseUs = pulseForSignedSpeed(signedSpeedForSide(direction, false, appliedSpeed));
    const int ttlMs = clampInt(durationMs > 0 ? durationMs : static_cast<int>(kWatchdogTimeoutMs), 100, 5000);

    const bool changed = leftPulseUs != targetLeftPulseUs ||
                         rightPulseUs != targetRightPulseUs ||
                         strcmp(activeDirection, direction) != 0;

    setTargetPulses(leftPulseUs, rightPulseUs);
    setActiveDirection(direction);
    commandDeadlineAtMs = millis() + static_cast<unsigned long>(ttlMs);
    commandDeadlineActive = true;
    setLastError("");
    if (changed) {
        markStatusDirty();
    }
}

void completeArmingIfReady(unsigned long now) {
    if (!isArming()) {
        return;
    }

    if (static_cast<long>(now - armingCompleteAtMs) < 0) {
        return;
    }

    motorState = MotorState::Armed;
    armingCompleteAtMs = 0;
    setActiveDirection("stop");
    setTargetPulses(kNeutralPulseUs, kNeutralPulseUs);
    publishMotorStatus("armed");
}

void enforceWatchdog(unsigned long now) {
    if (!commandDeadlineActive) {
        return;
    }

    if (static_cast<long>(now - commandDeadlineAtMs) >= 0) {
        stopMotors("watchdog_timeout");
    }
}

void updateOutputs(unsigned long now) {
    if (lastOutputUpdateMs == 0) {
        lastOutputUpdateMs = now;
    }

    if (now - lastOutputUpdateMs < kUpdateIntervalMs) {
        return;
    }
    lastOutputUpdateMs = now;

    const int nextLeft = moveTowards(currentLeftPulseUs, targetLeftPulseUs, kRampStepUs);
    const int nextRight = moveTowards(currentRightPulseUs, targetRightPulseUs, kRampStepUs);
    if (nextLeft == currentLeftPulseUs && nextRight == currentRightPulseUs) {
        return;
    }

    currentLeftPulseUs = nextLeft;
    currentRightPulseUs = nextRight;
    applyCurrentPulses();
    markStatusDirty();
}

void maybePublishStatus(unsigned long now) {
    const bool periodicStatusDue = now - lastStatusPublishMs >= kStatusPublishIntervalMs;
    const bool dirtyStatusDue = statusDirty && now - lastStatusPublishMs >= kDirtyStatusPublishIntervalMs;
    if (dirtyStatusDue || periodicStatusDue) {
        publishMotorStatus();
    }
}

void handleCommandLine(const char *line) {
    char command[32] = "";
    char id[64] = "";
    extractJsonString(line, "id", id, sizeof(id));

    if (!extractJsonString(line, "command", command, sizeof(command))) {
        return;
    }

    if (strcmp(command, "motor_status") == 0) {
        publishAck(id, "motor_status_sent", command);
        publishMotorStatus("requested");
        return;
    }

    if (strcmp(command, "arm_motors") == 0) {
        beginArm(id);
        return;
    }

    if (strcmp(command, "disarm_motors") == 0) {
        disarmMotors(id);
        return;
    }

    if (strcmp(command, "stop") == 0) {
        stopMotors("commanded_stop");
        publishAck(id, "motor_stopped", command);
        publishMotorStatus("commanded_stop");
        return;
    }

    if (strcmp(command, "drive") == 0) {
        char direction[16] = "";
        float speed = 0.0f;
        int durationMs = static_cast<int>(kWatchdogTimeoutMs);

        extractJsonString(line, "direction", direction, sizeof(direction));
        extractJsonFloat(line, "speed", speed);
        extractJsonInt(line, "durationMs", durationMs);
        applyDriveCommand(id, direction, speed, durationMs);
        return;
    }

    publishAck(id, "unsupported_motor_command", command);
}

void flushSerialLineBuffer() {
    if (serialLineLength == 0) {
        return;
    }
    serialLineBuffer[serialLineLength] = '\0';
    handleCommandLine(serialLineBuffer);
    serialLineLength = 0;
}

void processSerialByte(char ch) {
    if (ch == '\r') {
        return;
    }
    if (ch == '\n') {
        flushSerialLineBuffer();
        return;
    }

    if (serialLineLength < kSerialLineBufferSize - 1) {
        serialLineBuffer[serialLineLength++] = ch;
    } else {
        serialLineLength = 0;
        setLastError("serial line too long");
        markStatusDirty();
    }
}

void setup() {
    ledcSetup(kLeftEscChannel, kServoFrequencyHz, kPwmResolutionBits);
    ledcSetup(kRightEscChannel, kServoFrequencyHz, kPwmResolutionBits);
    ledcAttachPin(kLeftEscPin, kLeftEscChannel);
    ledcAttachPin(kRightEscPin, kRightEscChannel);
    forcePulses(kNeutralPulseUs, kNeutralPulseUs);

    Serial.begin(115200);
    delay(200);
    publishMotorStatus("boot");
}

void loop() {
    while (Serial.available() > 0) {
        processSerialByte(static_cast<char>(Serial.read()));
    }

    const unsigned long now = millis();
    completeArmingIfReady(now);
    enforceWatchdog(now);
    updateOutputs(now);
    maybePublishStatus(now);
}
