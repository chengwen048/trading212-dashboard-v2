#!/usr/bin/env python3
import datetime as dt
import json
import sys


def main():
    symbol = sys.argv[1] if len(sys.argv) > 1 else ""
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 390
    start = (dt.date.today() - dt.timedelta(days=days)).isoformat()
    end = dt.date.today().isoformat()

    try:
        import baostock as bs
    except Exception as exc:
        print(json.dumps({"error": f"baostock import failed: {exc}"}))
        return 2

    login = bs.login()
    if login.error_code != "0":
        print(json.dumps({"error": login.error_msg or "baostock login failed"}))
        return 3

    try:
        result = bs.query_history_k_data_plus(
            symbol,
            "date,open,high,low,close,volume,turn,pctChg",
            start_date=start,
            end_date=end,
            frequency="d",
            adjustflag="2",
        )
        if result.error_code != "0":
            print(json.dumps({"error": result.error_msg or "baostock query failed"}))
            return 4

        candles = []
        while result.next():
            row = result.get_row_data()
            try:
                candles.append(
                    {
                        "time": int(dt.datetime.fromisoformat(row[0]).timestamp() * 1000),
                        "open": float(row[1]),
                        "high": float(row[2]),
                        "low": float(row[3]),
                        "close": float(row[4]),
                        "volume": float(row[5] or 0),
                        "turnover": float(row[6] or 0),
                        "pctChg": float(row[7] or 0),
                    }
                )
            except Exception:
                continue
        print(json.dumps({"symbol": symbol, "candles": candles}, ensure_ascii=False))
        return 0
    finally:
        bs.logout()


if __name__ == "__main__":
    raise SystemExit(main())
