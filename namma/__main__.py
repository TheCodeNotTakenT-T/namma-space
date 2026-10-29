"""Single public command for the Namma Space workflow.

    python -m namma check --out setup-logs/<run>            # GPU/native-extension checks + report
    python -m namma prepare --video V --jobs-root DIR       # create the job (and its smoke test) for a video
    python -m namma run --job DIR [--until STAGE]           # run or resume every stage
    python -m namma status --job DIR                        # print the job's status.json
Drive backup/restore runs with the notebook's Python: python -m namma.backup --help
"""
import argparse
import json
import sys


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m namma")
    commands = parser.add_subparsers(dest="command", required=True)

    check = commands.add_parser("check", help="Run real GPU checks of every native extension and write a report")
    check.add_argument("--out", required=True, help="Directory for report.json / report.md")
    check.add_argument("--only", nargs="*", help="Run only these check names")

    prepare = commands.add_parser("prepare", help="Create the job folder for a video")
    prepare.add_argument("--video", required=True)
    prepare.add_argument("--jobs-root", required=True)
    prepare.add_argument("--settings", help='JSON overrides, e.g. {"train": {"steps": 40000}}')

    run = commands.add_parser("run", help="Run or resume a job")
    run.add_argument("--job", required=True)
    run.add_argument("--until", help="Stop after this stage")

    status = commands.add_parser("status", help="Show a job's status")
    status.add_argument("--job", required=True)

    args = parser.parse_args(argv)
    if args.command == "check":
        from namma import gpu_check
        return gpu_check.run_all(args.out, args.only)
    if args.command == "prepare":
        from namma import pipeline
        print(json.dumps(pipeline.prepare(args.video, args.jobs_root, json.loads(args.settings) if args.settings else None)))
        return 0
    if args.command == "run":
        from namma import pipeline
        return pipeline.run(args.job, args.until)
    if args.command == "status":
        from namma.workspace import Workspace, read_json
        print(json.dumps(read_json(Workspace(args.job).root / "status.json", {}), indent=1))
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
