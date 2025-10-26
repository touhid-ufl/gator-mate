import json
import os
import sys
import time  # Import the full time module

CONFIG_PATH = "config.json"
COURSES_DIR = os.path.join(os.getcwd(), "courses")

def main():
    # Ensure UTF-8 output on Windows console
    sys.stdout.reconfigure(encoding='utf-8')

    if not os.path.exists(CONFIG_PATH):
        print("Warning: config.json not found.")
        return

    # Load CURRENT_COURSE from config.json
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    current_course = cfg.get("CURRENT_COURSE", "unknown")
    print(f"Checking transcript for course: {current_course}")

    # --- Added Delay ---
    # Add a short pause to simulate a loading/checking process
    print("...")
    time.sleep(30)  # Pause execution for 1.5 seconds
    # -------------------

    # Build expected transcript path
    course_dir = os.path.join(COURSES_DIR, current_course)
    transcript_path = os.path.join(course_dir, "transcript.json")

    # Ensure course directory exists
    if not os.path.exists(course_dir):
        print(f"Course directory not found: {course_dir}")
        return

    # Check transcript.json availability
    if os.path.exists(transcript_path):
        print(f"✅ transcript.json found for '{current_course}' at: {transcript_path}")
    else:
        print(f"❌ transcript.json is missing for '{current_course}'.")


if __name__ == "__main__":
    main()