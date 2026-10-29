"""Desktop entry point: import a trained result, open the scene library, package a browser demo."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[2]


def open_viewer(scene_id=None, browser=True):
    def live():
        try:
            with urllib.request.urlopen("http://127.0.0.1:5174/__scenes", timeout=2) as response:
                return isinstance(json.load(response), list)
        except (OSError, ValueError):
            return False
    if not live():
        log = ROOT / "output/viewer-server.log"
        log.parent.mkdir(exist_ok=True)
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        with log.open("ab") as stream:
            process = subprocess.Popen(
                [shutil.which("node") or "node", str(ROOT / "viewer/node_modules/vite/bin/vite.js"),
                 "--host", "127.0.0.1", "--port", "5174", "--strictPort"],
                cwd=ROOT / "viewer", stdout=stream, stderr=subprocess.STDOUT,
                creationflags=flags)
        for _ in range(40):
            if live():
                break
            if process.poll() is not None:
                raise RuntimeError("Viewer could not start. See " + str(log))
            time.sleep(0.5)
        else:
            raise RuntimeError("Viewer did not become ready. See " + str(log))
    if scene_id and not all(c.isalnum() or c == "-" for c in scene_id):
        raise ValueError("Invalid scene id")
    url = "http://127.0.0.1:5174/aholo/" + ("?scene=" + scene_id if scene_id else "")
    if browser:
        webbrowser.open(url)
    return url


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--open", metavar="SCENE_ID")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if args.open:
        print(open_viewer(args.open, not args.no_browser))
        return
    import tkinter as tk
    from tkinter import filedialog, messagebox, simpledialog
    import threading
    window = tk.Tk()
    window.title("Namma Space pipeline")
    window.geometry("580x400")
    window.configure(padx=24, pady=20)
    tk.Label(window, text="Namma Space", font=("Segoe UI", 22, "bold")).pack(anchor="w")
    tk.Label(window, text="Import a trained result, inspect and walk, then package a browser demo.",
             wraplength=520, justify="left").pack(anchor="w", pady=10)
    status = tk.StringVar(value="Original files are preserved. No paid resources are provisioned.")
    buttons = []
    def run(action):
        for button in buttons:
            button.configure(state="disabled")
        status.set("Working… Progress is in the terminal and saved job logs.")
        def work():
            try:
                result = action()
                window.after(0, lambda value=result: status.set(value or "Finished."))
            except Exception as error:
                window.after(0, lambda text=str(error): messagebox.showerror("Stopped", text))
                window.after(0, lambda: status.set("Stopped. Original files and job logs are preserved."))
            finally:
                window.after(0, lambda: [b.configure(state="normal") for b in buttons])
        threading.Thread(target=work, daemon=False).start()
    def import_result():
        file = filedialog.askopenfilename(title="Select geometry/result ZIP or its parts.json",
                                         filetypes=[("Scene result", "*.zip *.json")])
        if not file:
            return
        title = simpledialog.askstring("Scene name", "Name this room:", initialvalue="My room")
        if not title:
            return
        def process():
            spec = importlib.util.spec_from_file_location("scene_pipeline", Path(__file__).with_name("scene-pipeline.py"))
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            result = module.import_scene(file, None, None, title)
            open_viewer(result["id"])
            return "Imported and opened. Inspect the surfaces and set floor/scale before testing walking."
        run(process)
    def view():
        library = ROOT / "data/scene-library"
        choices = sorted(library.glob("*/scene.json")) if library.exists() else []
        if not choices:
            messagebox.showinfo("No imported scenes", "Import a trained result first.")
            return
        run(lambda: open_viewer(choices[-1].parent.name))
    def browser_demo():
        choices = []
        for manifest in sorted((ROOT / "data/scene-library").glob("*/scene.json")):
            try:
                choices.append((str(json.loads(manifest.read_text(encoding="utf-8"))["title"]), manifest))
            except (OSError, ValueError, KeyError):
                continue
        if not choices:
            messagebox.showinfo("No imported scenes", "Import a trained result first.")
            return
        selected = []
        picker = tk.Toplevel(window)
        picker.title("Choose your demo room")
        picker.geometry("460x310")
        tk.Label(picker, text="Choose the room you have tested walking in:").pack(pady=10)
        rooms = tk.Listbox(picker, exportselection=False)
        rooms.pack(fill="both", expand=True, padx=16)
        for title, _ in choices:
            rooms.insert("end", title)
        rooms.selection_set(len(choices) - 1)
        def choose():
            if rooms.curselection():
                selected.append(choices[rooms.curselection()[0]][1])
                picker.destroy()
        tk.Button(picker, text="Use this room", command=choose).pack(pady=12)
        picker.transient(window)
        picker.grab_set()
        window.wait_window(picker)
        if not selected:
            return
        scene = str(selected[0])
        setup = filedialog.askopenfilename(title="Choose namma-walking-setup.json downloaded from that room's Walking setup panel",
            filetypes=[("Walking setup", "*.json")])
        if not setup:
            return
        def package():
            stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + str(time.time_ns())[-6:]
            output = ROOT / "output" / ("aholo-demo-" + stamp)
            log = ROOT / "output" / ("demo-build-" + stamp + ".log")
            log.parent.mkdir(exist_ok=True)
            node = shutil.which("node") or "node"
            with log.open("x", encoding="utf-8") as stream:
                built = subprocess.run([node, str(ROOT / "viewer/node_modules/vite/bin/vite.js"), "build"],
                    cwd=ROOT / "viewer", stdout=stream, stderr=subprocess.STDOUT, timeout=300)
            if built.returncode:
                raise RuntimeError("Viewer build stopped. See " + str(log))
            subprocess.run([node, str(ROOT / "viewer/scripts/package-aholo-scene.mjs"),
                "--scene", scene, "--setup", setup, "--output", str(output)], check=True, timeout=300)
            if sys.platform == "win32":
                os.startfile(output)
            return "Browser demo packaged in " + str(output) + ". Read README.md to preview. Nothing was published."
        run(package)
    for text, callback in [("1. Import a trained result", import_result), ("2. Open my scene library", view),
                           ("3. Package a browser demo", browser_demo)]:
        button = tk.Button(window, text=text, command=callback, anchor="w", padx=12, pady=8)
        button.pack(fill="x", pady=4)
        buttons.append(button)
    tk.Label(window, textvariable=status, wraplength=520, justify="left").pack(anchor="w", pady=14)
    window.mainloop()


if __name__ == "__main__":
    main()
