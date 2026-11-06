"""DSH 关闭后清理旧的本地认证 Cookie。

由 dsh-lqconfig 启动时拉起：stdin 接在 host 进程的管道上。
host 退出（正常退出或被结束）时管道关闭，本脚本才开始动手，
此时 Electron 已经释放 Network\\Cookies 的独占锁，可以直接删。

配置在关闭时才从 state.json 读取，所以改设置不需要重启应用。

用法（手动测试）：
    python cleanup-cookies.py --now --db <Cookies 路径> --keep 2 --min 30 --report <json 路径>
"""

import argparse
import datetime
import json
import os
import sqlite3
import sys
import time

DEFAULT_DB = os.path.join(
    os.environ.get("APPDATA", ""),
    "@deepseek-ai",
    "dsh-desktop",
    "Network",
    "Cookies",
)
SCOPE = "name like 'dsh-auth%'"


def wait_for_parent() -> None:
    """阻塞到 stdin 被父进程关闭（父进程退出）。"""
    try:
        while True:
            chunk = sys.stdin.buffer.read(1)
            if not chunk:
                return
    except Exception:  # noqa: BLE001
        return


def read_settings(state_path: str, keep: int, min_count: int) -> tuple:
    """关闭时重新读 state.json，让界面上改的值立刻生效。"""
    enabled = True
    if state_path and os.path.exists(state_path):
        try:
            with open(state_path, "r", encoding="utf-8-sig") as handle:
                value = json.load(handle)
            if isinstance(value, dict):
                enabled = value.get("cookieAutoClean") is not False
                if isinstance(value.get("cookieKeep"), (int, float)):
                    keep = int(value["cookieKeep"])
                if isinstance(value.get("cookieCleanMin"), (int, float)):
                    min_count = int(value["cookieCleanMin"])
        except Exception:  # noqa: BLE001
            pass
    return enabled, max(1, min(10, keep)), max(1, min(1000, min_count))


def cleanup(db: str, keep: int, min_count: int, timeout: int) -> dict:
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            conn = sqlite3.connect(db, timeout=5)
            try:
                total = conn.execute(f"select count(*) from cookies where {SCOPE}").fetchone()[0]
                if total <= min_count:
                    return {"ok": True, "found": total, "removed": 0, "kept": total, "skipped": "below-min", "min": min_count}
                keep_ids = [
                    row[0]
                    for row in conn.execute(
                        f"select rowid from cookies where {SCOPE} order by creation_utc desc limit ?",
                        (keep,),
                    )
                ]
                if keep_ids:
                    marks = ",".join("?" * len(keep_ids))
                    cur = conn.execute(
                        f"delete from cookies where {SCOPE} and rowid not in ({marks})",
                        keep_ids,
                    )
                    removed = cur.rowcount
                else:
                    removed = 0
                conn.commit()
                conn.execute("vacuum")
                conn.commit()
                return {"ok": True, "found": total, "removed": removed, "kept": total - removed, "min": min_count}
            finally:
                conn.close()
        except sqlite3.OperationalError as error:  # 通常是 database is locked
            last_error = str(error)
            time.sleep(3)
        except Exception as error:  # noqa: BLE001
            last_error = str(error)
            time.sleep(3)
    return {"ok": False, "error": last_error, "min": min_count}


def write_report(path: str, payload: dict) -> None:
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="DSH 关闭后清理旧 dsh-auth Cookie")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--state", default="", help="state.json 路径（关闭时读取开关与数值）")
    ap.add_argument("--keep", type=int, default=2)
    ap.add_argument("--min", type=int, default=30, dest="min_count")
    ap.add_argument("--timeout", type=int, default=180)
    ap.add_argument("--report", default="")
    ap.add_argument("--now", action="store_true", help="不等待父进程，立即执行（测试用）")
    args = ap.parse_args()

    if not args.now:
        wait_for_parent()
        time.sleep(2)

    enabled, keep, min_count = read_settings(args.state, args.keep, args.min_count)

    if not enabled:
        payload = {
            "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "mode": "on-close",
            "ok": True,
            "skipped": "disabled",
            "min": min_count,
        }
    elif not os.path.exists(args.db):
        payload = {
            "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "mode": "on-close",
            "ok": False,
            "error": f"找不到数据库 {args.db}",
            "min": min_count,
        }
    else:
        result = cleanup(args.db, keep, min_count, args.timeout)
        payload = {
            "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "mode": "on-close",
            **result,
        }

    if args.report:
        write_report(args.report, payload)
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
