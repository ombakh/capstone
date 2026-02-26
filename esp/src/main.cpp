#include <Arduino.h>

constexpr uint32_t kBlinkIntervalMs = 500;
#ifdef LED_BUILTIN
constexpr uint8_t kLedPin = LED_BUILTIN;
#else
constexpr uint8_t kLedPin = 2;
#endif

void setup() {
  pinMode(kLedPin, OUTPUT);
  Serial.begin(115200);
  delay(250);
  Serial.println("ESP32 PlatformIO project started");
}

void loop() {
  digitalWrite(kLedPin, HIGH);
  delay(kBlinkIntervalMs);
  digitalWrite(kLedPin, LOW);
  delay(kBlinkIntervalMs);
}
