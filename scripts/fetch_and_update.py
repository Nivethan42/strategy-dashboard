from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
STRATEGY_DIR = DATA_DIR / "strategies"

DATA_DIR.mkdir(exist_ok=True)
STRATEGY_DIR.mkdir(parents=True, exist_ok=True)

TIMEZONE = ZoneInfo("America/New_York")
MAX_REFRESH_LOG_ROWS = 400


def now_ny() -> datetime:
    return datetime.now(TIMEZONE)


def clean_date_index(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df

    idx = df.index
    try:
        if getattr(idx, "tz", None) is not None:
            idx = idx.tz_convert(TIMEZONE).tz_localize(None)
    except Exception:
        try:
            idx = idx.tz_localize(None)
        except Exception:
            pass

    out = df.copy()
    out.index = pd.to_datetime(pd.Index(idx).date)
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out


def get_daily_opens(ticker: str) -> pd.Series:
    daily = yf.Ticker(ticker).history(
        start="2000-01-01",
        interval="1d",
        auto_adjust=False,
        actions=False,
    )

    if daily.empty:
        raise RuntimeError(f"No daily data returned for {ticker}")

    daily = clean_date_index(daily)[["Open"]].dropna()
    series = daily["Open"].astype(float).rename(ticker)

    # Try to capture today's official open from intraday data if available.
    try:
        intraday = yf.Ticker(ticker).history(
            period="5d",
            interval="1m",
            auto_adjust=False,
            actions=False,
            prepost=True,
        )

        if not intraday.empty:
            try:
                if getattr(intraday.index, "tz", None) is None:
                    intraday.index = intraday.index.tz_localize(TIMEZONE)
                else:
                    intraday.index = intraday.index.tz_convert(TIMEZONE)
            except Exception:
                pass

            today_ny = now_ny().date()
            intraday_today = intraday[intraday.index.date == today_ny]

            if not intraday_today.empty:
                regular_open_bar = intraday_today.between_time("09:30", "09:30")
                if not regular_open_bar.empty and pd.notna(regular_open_bar.iloc[0]["Open"]):
                    series.loc[pd.Timestamp(today_ny)] = float(regular_open_bar.iloc[0]["Open"])
                    series = series.sort_index()
    except Exception:
        pass

    return series


def pct_str(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"{value * 100:.2f}%"


def num_str(value: float | None, digits: int = 4) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"{value:.{digits}f}"


def price_str(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"${value:.2f}"


def calculate_streak(signal: pd.Series) -> tuple[str, int]:
    if signal.empty:
        return ("NONE", 0)
    signal_int = signal.astype(int)
    latest = int(signal_int.iloc[-1])
    streak = 0
    for v in reversed(signal_int.tolist()):
        if int(v) == latest:
            streak += 1
        else:
            break
    return ("BUY" if latest == 1 else "CASH", streak)


def simulate_strategy(traded_open: pd.Series, signal: pd.Series) -> tuple[dict, pd.Series]:
    sim = pd.DataFrame({"open": traded_open.astype(float)}).join(
        signal.rename("position"), how="left"
    )
    sim["position"] = sim["position"].fillna(0).astype(int)
    sim = sim.dropna(subset=["open"]).copy()

    sim["forward_ret"] = sim["open"].shift(-1) / sim["open"] - 1
    sim["strategy_ret"] = sim["position"] * sim["forward_ret"]

    valid = sim.dropna(subset=["strategy_ret"]).copy()
    if valid.empty:
        empty_stats = {
            "cagr": None,
            "max_drawdown": None,
            "trades": 0,
            "window_start": None,
            "window_end": None,
        }
        return empty_stats, pd.Series(dtype=float)

    equity = (1 + valid["strategy_ret"]).cumprod()
    drawdown = equity / equity.cummax() - 1

    days = max((valid.index[-1] - valid.index[0]).days, 1)
    cagr = float(equity.iloc[-1] ** (365.25 / days) - 1)

    position = sim["position"]
    entries = ((position == 1) & (position.shift(1, fill_value=0) == 0)).sum()

    stats = {
        "cagr": cagr,
        "max_drawdown": float(drawdown.min()),
        "trades": int(entries),
        "window_start": valid.index[0].strftime("%Y-%m-%d"),
        "window_end": valid.index[-1].strftime("%Y-%m-%d"),
    }
    return stats, equity


def tqqq_strategy(qqq_open: pd.Series, tqqq_open: pd.Series) -> dict:
    df = pd.DataFrame(index=qqq_open.index)
    df["source_open"] = qqq_open.astype(float)

    sma20 = df["source_open"].shift(1).rolling(20).mean()
    df["sslp20_2"] = sma20 / sma20.shift(2) - 1
    df["mom150"] = df["source_open"].shift(1) / df["source_open"].shift(151) - 1

    oo_ret = df["source_open"] / df["source_open"].shift(1) - 1
    df["rv5"] = oo_ret.shift(1).rolling(5).std(ddof=0)
    df["rv7"] = oo_ret.shift(1).rolling(7).std(ddof=0)

    sma63 = df["source_open"].shift(1).rolling(63).mean()
    sma126 = df["source_open"].shift(1).rolling(126).mean()
    df["sr63_126"] = sma63 / sma126

    df["signal"] = (
        ((df["sslp20_2"] < -0.008) | (df["mom150"] > -0.01))
        & (df["rv5"] < 0.03)
        & (df["rv7"] < 0.03)
        & (df["sr63_126"] < 1.05)
    ).fillna(False).astype(int)

    latest_idx = df.dropna(subset=["sslp20_2", "mom150", "rv5", "rv7", "sr63_126"]).index[-1]
    prev_idx = df.index[df.index.get_loc(latest_idx) - 1]

    latest_signal = int(df.loc[latest_idx, "signal"])
    prev_signal = int(df.loc[prev_idx, "signal"])
    changed_today = latest_signal != prev_signal

    stats, equity = simulate_strategy(tqqq_open, df["signal"])
    streak_type, streak_len = calculate_streak(df.loc[:latest_idx, "signal"])

    indicators = [
        {
            "key": "sslp20_2",
            "label": "SSLP20_2",
            "displayValue": pct_str(float(df.loc[latest_idx, "sslp20_2"])),
            "rawValue": float(df.loc[latest_idx, "sslp20_2"]),
            "rule": "< -0.008",
            "passed": bool(df.loc[latest_idx, "sslp20_2"] < -0.008),
            "description": "20-day SMA / same SMA from 2 trading days earlier - 1.",
        },
        {
            "key": "mom150",
            "label": "MOM150",
            "displayValue": pct_str(float(df.loc[latest_idx, "mom150"])),
            "rawValue": float(df.loc[latest_idx, "mom150"]),
            "rule": "> -0.01",
            "passed": bool(df.loc[latest_idx, "mom150"] > -0.01),
            "description": "QQQ Open[t-1] / QQQ Open[t-151] - 1.",
        },
        {
            "key": "rv5",
            "label": "RV5",
            "displayValue": pct_str(float(df.loc[latest_idx, "rv5"])),
            "rawValue": float(df.loc[latest_idx, "rv5"]),
            "rule": "< 0.03",
            "passed": bool(df.loc[latest_idx, "rv5"] < 0.03),
            "description": "Std dev of prior 5 open-to-open returns.",
        },
        {
            "key": "rv7",
            "label": "RV7",
            "displayValue": pct_str(float(df.loc[latest_idx, "rv7"])),
            "rawValue": float(df.loc[latest_idx, "rv7"]),
            "rule": "< 0.03",
            "passed": bool(df.loc[latest_idx, "rv7"] < 0.03),
            "description": "Std dev of prior 7 open-to-open returns.",
        },
        {
            "key": "sr63_126",
            "label": "SR63_126",
            "displayValue": num_str(float(df.loc[latest_idx, "sr63_126"])),
            "rawValue": float(df.loc[latest_idx, "sr63_126"]),
            "rule": "< 1.05",
            "passed": bool(df.loc[latest_idx, "sr63_126"] < 1.05),
            "description": "63-day prior SMA / 126-day prior SMA.",
        },
    ]

    history = []
    joined_traded = tqqq_open.reindex(df.index)
    eq_aligned = equity.reindex(df.index)
    for dt, row in df.tail(420).iterrows():
        history.append(
            {
                "date": dt.strftime("%Y-%m-%d"),
                "sourceOpen": round(float(row["source_open"]), 4) if pd.notna(row["source_open"]) else None,
                "tradedOpen": round(float(joined_traded.loc[dt]), 4) if pd.notna(joined_traded.loc[dt]) else None,
                "signal": int(row["signal"]),
                "signalText": "BUY" if int(row["signal"]) == 1 else "CASH",
                "equity": round(float(eq_aligned.loc[dt]), 6) if pd.notna(eq_aligned.loc[dt]) else None,
                "sslp20_2": round(float(row["sslp20_2"]), 6) if pd.notna(row["sslp20_2"]) else None,
                "mom150": round(float(row["mom150"]), 6) if pd.notna(row["mom150"]) else None,
                "rv5": round(float(row["rv5"]), 6) if pd.notna(row["rv5"]) else None,
                "rv7": round(float(row["rv7"]), 6) if pd.notna(row["rv7"]) else None,
                "sr63_126": round(float(row["sr63_126"]), 6) if pd.notna(row["sr63_126"]) else None,
            }
        )

    latest_row = df.loc[latest_idx]
    traded_latest = tqqq_open.reindex(df.index).loc[latest_idx]

    return {
        "id": "tqqq",
        "displayName": "TQQQ Strategy",
        "sourceTicker": "QQQ",
        "tradedTicker": "TQQQ",
        "subtitle": "QQQ signal, prior-data only, trade TQQQ at today's open.",
        "latestTradingDay": latest_idx.strftime("%Y-%m-%d"),
        "lastUpdated": now_ny().strftime("%Y-%m-%d %H:%M:%S %Z"),
        "currentSignal": "BUY" if latest_signal == 1 else "CASH",
        "signalIsBuy": bool(latest_signal == 1),
        "currentActionText": "Buy TQQQ at today's open" if latest_signal == 1 else "Hold cash / no long position",
        "signalChangeSummary": "Changed today" if changed_today else "No signal change today",
        "streakType": streak_type,
        "streakLength": streak_len,
        "latestOpen": {
            "source": price_str(float(latest_row["source_open"])),
            "traded": price_str(float(traded_latest)) if pd.notna(traded_latest) else "N/A",
        },
        "formula": {
            "buy": [
                "(SSLP20_2 < -0.008 OR MOM150 > -0.01) AND RV5 < 0.03 AND RV7 < 0.03 AND SR63_126 < 1.05",
                "Equivalent to screenshot rule where RV7 < 0.03 and RV7 < 0.035 both appear: stricter RV7 < 0.03 governs.",
            ],
            "sell": [
                "Sell / go CASH when both trigger conditions fail (SSLP20_2 >= -0.008 AND MOM150 <= -0.01), or RV5 >= 0.03, or RV7 >= 0.03, or SR63_126 >= 1.05.",
            ],
            "definitions": [
                "SMA20[t] = average of QQQ Opens from t-1..t-20",
                "SSLP20_2[t] = (SMA20[t] / SMA20[t-2]) - 1",
                "MOM150[t] = (QQQ Open[t-1] / QQQ Open[t-151]) - 1",
                "RV5[t] = stdev of prior 5 open-to-open returns",
                "RV7[t] = stdev of prior 7 open-to-open returns",
                "SMA63[t] = average QQQ Opens from t-1..t-63",
                "SMA126[t] = average QQQ Opens from t-1..t-126",
                "SR63_126[t] = SMA63[t] / SMA126[t]",
            ],
        },
        "plainEnglish": [
            "Stay invested when either the 20-day slope has dropped enough over the last 2 days OR 150-day momentum remains better than -1%.",
            "Short-term open-to-open volatility must stay low (RV5 and RV7 caps).",
            "The 63-day trend must not be too stretched above the 126-day trend.",
            "All indicators use prior data (t-1 and earlier), and trades are modeled open-to-open in TQQQ.",
        ],
        "indicators": indicators,
        "backtest": {
            "cagr": pct_str(stats["cagr"]),
            "maxDrawdown": pct_str(stats["max_drawdown"]),
            "tradeCount": stats["trades"],
            "window": f"{stats['window_start']} to {stats['window_end']}",
        },
        "chart": {
            "sourceLabel": "QQQ Open",
            "tradedLabel": "TQQQ Open",
            "history": history,
        },
        "signalHistory": history,
    }


def spxl_strategy(spy_open: pd.Series, spxl_open: pd.Series) -> dict:
    df = pd.DataFrame(index=spy_open.index)
    df["source_open"] = spy_open.astype(float)

    df["mom90"] = df["source_open"].shift(1) / df["source_open"].shift(91) - 1
    df["mom100"] = df["source_open"].shift(1) / df["source_open"].shift(101) - 1

    rolling_100 = df["source_open"].shift(1).rolling(100).mean()
    df["abvma100"] = df["source_open"].shift(1) > rolling_100

    sma5 = df["source_open"].shift(1).rolling(5).mean()
    df["slp5_1"] = sma5 / sma5.shift(1) - 1

    sma20 = df["source_open"].shift(1).rolling(20).mean()
    df["slp20_1"] = sma20 / sma20.shift(1) - 1
    df["slp20_3"] = sma20 / sma20.shift(3) - 1

    oo_ret = df["source_open"] / df["source_open"].shift(1) - 1
    vol20 = oo_ret.shift(1).rolling(20).std(ddof=0)
    vol100 = oo_ret.shift(1).rolling(100).std(ddof=0)
    df["vr20_100"] = vol20 / vol100

    cond_cols = ["mom90", "mom100", "abvma100", "slp5_1", "slp20_1", "slp20_3"]
    bool_map = pd.DataFrame(index=df.index)
    bool_map["mom90"] = df["mom90"] > 0
    bool_map["mom100"] = df["mom100"] > 0
    bool_map["abvma100"] = df["abvma100"] == True
    bool_map["slp5_1"] = df["slp5_1"] > 0
    bool_map["slp20_1"] = df["slp20_1"] > 0
    bool_map["slp20_3"] = df["slp20_3"] > 0

    score = bool_map[cond_cols].sum(axis=1)

    buy_condition = (score >= 3) & (df["vr20_100"] < 1.4)
    sell_condition = (score <= 1) | (df["vr20_100"] >= 1.4)

    signal = pd.Series(index=df.index, dtype=int)
    current = 0
    for i, idx in enumerate(df.index):
        if pd.isna(df.loc[idx, "vr20_100"]):
            signal.iloc[i] = current
            continue
        if current == 0 and bool(buy_condition.loc[idx]):
            current = 1
        elif current == 1 and bool(sell_condition.loc[idx]):
            current = 0
        signal.iloc[i] = current

    df["score"] = score
    df["signal"] = signal.fillna(0).astype(int)

    latest_idx = df.dropna(subset=["mom90", "mom100", "slp5_1", "slp20_1", "slp20_3", "vr20_100"]).index[-1]
    prev_idx = df.index[df.index.get_loc(latest_idx) - 1]

    latest_signal = int(df.loc[latest_idx, "signal"])
    prev_signal = int(df.loc[prev_idx, "signal"])
    changed_today = latest_signal != prev_signal

    stats, equity = simulate_strategy(spxl_open, df["signal"])
    streak_type, streak_len = calculate_streak(df.loc[:latest_idx, "signal"])

    indicators = [
        {
            "key": "score",
            "label": "Score (6 checks)",
            "displayValue": str(int(df.loc[latest_idx, "score"])),
            "rawValue": float(df.loc[latest_idx, "score"]),
            "rule": ">= 3 to buy",
            "passed": bool(df.loc[latest_idx, "score"] >= 3),
            "description": "Count of MOM90, MOM100, ABVMA100, SLP5_1, SLP20_1, SLP20_3 that pass.",
        },
        {
            "key": "mom90",
            "label": "MOM90",
            "displayValue": pct_str(float(df.loc[latest_idx, "mom90"])),
            "rawValue": float(df.loc[latest_idx, "mom90"]),
            "rule": "> 0",
            "passed": bool(df.loc[latest_idx, "mom90"] > 0),
            "description": "SPY Open[t-1] / SPY Open[t-91] - 1.",
        },
        {
            "key": "mom100",
            "label": "MOM100",
            "displayValue": pct_str(float(df.loc[latest_idx, "mom100"])),
            "rawValue": float(df.loc[latest_idx, "mom100"]),
            "rule": "> 0",
            "passed": bool(df.loc[latest_idx, "mom100"] > 0),
            "description": "SPY Open[t-1] / SPY Open[t-101] - 1.",
        },
        {
            "key": "abvma100",
            "label": "ABVMA100",
            "displayValue": "TRUE" if bool(df.loc[latest_idx, "abvma100"]) else "FALSE",
            "rawValue": 1.0 if bool(df.loc[latest_idx, "abvma100"]) else 0.0,
            "rule": "TRUE",
            "passed": bool(df.loc[latest_idx, "abvma100"]),
            "description": "SPY Open[t-1] > average SPY Open over prior 100 days.",
        },
        {
            "key": "slp5_1",
            "label": "SLP5_1",
            "displayValue": pct_str(float(df.loc[latest_idx, "slp5_1"])),
            "rawValue": float(df.loc[latest_idx, "slp5_1"]),
            "rule": "> 0",
            "passed": bool(df.loc[latest_idx, "slp5_1"] > 0),
            "description": "5-day SMA slope versus 1 day ago.",
        },
        {
            "key": "slp20_1",
            "label": "SLP20_1",
            "displayValue": pct_str(float(df.loc[latest_idx, "slp20_1"])),
            "rawValue": float(df.loc[latest_idx, "slp20_1"]),
            "rule": "> 0",
            "passed": bool(df.loc[latest_idx, "slp20_1"] > 0),
            "description": "20-day SMA slope versus 1 day ago.",
        },
        {
            "key": "slp20_3",
            "label": "SLP20_3",
            "displayValue": pct_str(float(df.loc[latest_idx, "slp20_3"])),
            "rawValue": float(df.loc[latest_idx, "slp20_3"]),
            "rule": "> 0",
            "passed": bool(df.loc[latest_idx, "slp20_3"] > 0),
            "description": "20-day SMA slope versus 3 days ago.",
        },
        {
            "key": "vr20_100",
            "label": "VR20/100",
            "displayValue": num_str(float(df.loc[latest_idx, "vr20_100"]), 3),
            "rawValue": float(df.loc[latest_idx, "vr20_100"]),
            "rule": "< 1.4",
            "passed": bool(df.loc[latest_idx, "vr20_100"] < 1.4),
            "description": "20-day realized vol / 100-day realized vol.",
        },
    ]

    history = []
    joined_traded = spxl_open.reindex(df.index)
    eq_aligned = equity.reindex(df.index)
    for dt, row in df.tail(420).iterrows():
        history.append(
            {
                "date": dt.strftime("%Y-%m-%d"),
                "sourceOpen": round(float(row["source_open"]), 4) if pd.notna(row["source_open"]) else None,
                "tradedOpen": round(float(joined_traded.loc[dt]), 4) if pd.notna(joined_traded.loc[dt]) else None,
                "signal": int(row["signal"]),
                "signalText": "BUY" if int(row["signal"]) == 1 else "CASH",
                "equity": round(float(eq_aligned.loc[dt]), 6) if pd.notna(eq_aligned.loc[dt]) else None,
                "score": int(row["score"]) if pd.notna(row["score"]) else None,
                "mom90": round(float(row["mom90"]), 6) if pd.notna(row["mom90"]) else None,
                "mom100": round(float(row["mom100"]), 6) if pd.notna(row["mom100"]) else None,
                "abvma100": bool(row["abvma100"]) if pd.notna(row["abvma100"]) else None,
                "slp5_1": round(float(row["slp5_1"]), 6) if pd.notna(row["slp5_1"]) else None,
                "slp20_1": round(float(row["slp20_1"]), 6) if pd.notna(row["slp20_1"]) else None,
                "slp20_3": round(float(row["slp20_3"]), 6) if pd.notna(row["slp20_3"]) else None,
                "vr20_100": round(float(row["vr20_100"]), 6) if pd.notna(row["vr20_100"]) else None,
            }
        )

    latest_row = df.loc[latest_idx]
    traded_latest = spxl_open.reindex(df.index).loc[latest_idx]

    return {
        "id": "spxl",
        "displayName": "SPXL Strategy",
        "sourceTicker": "SPY",
        "tradedTicker": "SPXL",
        "subtitle": "SPY signal, prior-data only, trade SPXL at today's open.",
        "latestTradingDay": latest_idx.strftime("%Y-%m-%d"),
        "lastUpdated": now_ny().strftime("%Y-%m-%d %H:%M:%S %Z"),
        "currentSignal": "BUY" if latest_signal == 1 else "CASH",
        "signalIsBuy": bool(latest_signal == 1),
        "currentActionText": "Buy SPXL at today's open" if latest_signal == 1 else "Hold cash / no long position",
        "signalChangeSummary": "Changed today" if changed_today else "No signal change today",
        "streakType": streak_type,
        "streakLength": streak_len,
        "latestOpen": {
            "source": price_str(float(latest_row["source_open"])),
            "traded": price_str(float(traded_latest)) if pd.notna(traded_latest) else "N/A",
        },
        "formula": {
            "buy": [
                "Buy when at least 3 of the 6 trend checks pass AND VR20/100 < 1.4.",
                "Checks: MOM90>0, MOM100>0, ABVMA100=true, SLP5_1>0, SLP20_1>0, SLP20_3>0.",
            ],
            "sell": [
                "Sell when score falls to 1 or 0, OR VR20/100 >= 1.4.",
            ],
            "definitions": [
                "MOM90 = (SPY Open[t-1] / SPY Open[t-91]) - 1",
                "MOM100 = (SPY Open[t-1] / SPY Open[t-101]) - 1",
                "ABVMA100 = SPY Open[t-1] > average of SPY Opens[t-1] through [t-100]",
                "SLP5_1 = (SMA5[t-1] / SMA5[t-2]) - 1",
                "SLP20_1 = (SMA20[t-1] / SMA20[t-2]) - 1",
                "SLP20_3 = (SMA20[t-1] / SMA20[t-4]) - 1",
                "VR20/100 = stdev(open-to-open returns over prior 20 days) / stdev(open-to-open returns over prior 100 days)",
            ],
        },
        "plainEnglish": [
            "Buy SPXL when trend breadth is strong (3+ of 6 checks true) and volatility regime is calm (VR20/100 < 1.4).",
            "Sell SPXL when breadth weakens to 1 or 0 checks, or volatility regime spikes (VR20/100 >= 1.4).",
            "All indicators use prior data (t-1 and earlier), and trades are modeled open-to-open in SPXL.",
        ],
        "indicators": indicators,
        "backtest": {
            "cagr": pct_str(stats["cagr"]),
            "maxDrawdown": pct_str(stats["max_drawdown"]),
            "tradeCount": stats["trades"],
            "window": f"{stats['window_start']} to {stats['window_end']}",
        },
        "chart": {
            "sourceLabel": "SPY Open",
            "tradedLabel": "SPXL Open",
            "history": history,
        },
        "signalHistory": history,
    }


def append_refresh_log(entry: dict) -> None:
    path = DATA_DIR / "refresh_log.json"
    existing = []
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            existing = []

    if not isinstance(existing, list):
        existing = []

    existing.append(entry)
    trimmed = existing[-MAX_REFRESH_LOG_ROWS:]
    path.write_text(json.dumps(trimmed, indent=2), encoding="utf-8")


def ensure_changelog() -> None:
    path = DATA_DIR / "changelog.json"
    if path.exists():
        return

    initial = [
        {
            "version": "2.0.0",
            "date": now_ny().strftime("%Y-%m-%d"),
            "title": "Dual-strategy dashboard launch",
            "details": [
                "Added reusable strategy data model for TQQQ and SPXL.",
                "Added Overview / Compare / Update History / Methodology views.",
                "Added refresh_log.json and changelog.json rendering.",
            ],
            "commit": os.getenv("GITHUB_SHA", "local"),
        }
    ]
    path.write_text(json.dumps(initial, indent=2), encoding="utf-8")


def empty_strategy_payload(
    strategy_id: str,
    display_name: str,
    source_ticker: str,
    traded_ticker: str,
    subtitle: str,
) -> dict:
    ts = now_ny().strftime("%Y-%m-%d %H:%M:%S %Z")
    return {
        "id": strategy_id,
        "displayName": display_name,
        "sourceTicker": source_ticker,
        "tradedTicker": traded_ticker,
        "subtitle": subtitle,
        "latestTradingDay": None,
        "lastUpdated": ts,
        "currentSignal": "N/A",
        "signalIsBuy": False,
        "currentActionText": "No data available",
        "signalChangeSummary": "No data",
        "streakType": "N/A",
        "streakLength": 0,
        "latestOpen": {"source": "N/A", "traded": "N/A"},
        "formula": {"buy": [], "sell": [], "definitions": []},
        "plainEnglish": ["No data available yet."],
        "indicators": [],
        "backtest": {"cagr": "N/A", "maxDrawdown": "N/A", "tradeCount": 0, "window": "N/A"},
        "chart": {"sourceLabel": f"{source_ticker} Open", "tradedLabel": f"{traded_ticker} Open", "history": []},
        "signalHistory": [],
    }




def reference_tqqq_payload() -> dict:
    payload = empty_strategy_payload(
        "tqqq",
        "TQQQ Strategy",
        "QQQ",
        "TQQQ",
        "QQQ signal, prior-data only, trade TQQQ at today's open.",
    )
    payload["latestTradingDay"] = "2025-08-20"
    payload["currentActionText"] = "Live feed unavailable; showing reference strategy definition."
    payload["formula"] = {
        "buy": [
            "(SSLP20_2 < -0.008 OR MOM150 > -0.01) AND RV5 < 0.03 AND RV7 < 0.03 AND SR63_126 < 1.05",
            "Equivalent to screenshot rule where RV7 < 0.03 and RV7 < 0.035 both appear: stricter RV7 < 0.03 governs.",
        ],
        "sell": [
            "Sell / go CASH when both trigger conditions fail (SSLP20_2 >= -0.008 AND MOM150 <= -0.01), or RV5 >= 0.03, or RV7 >= 0.03, or SR63_126 >= 1.05.",
        ],
        "definitions": [
            "SMA20[t] = average of QQQ Opens from t-1..t-20",
            "SSLP20_2[t] = (SMA20[t] / SMA20[t-2]) - 1",
            "MOM150[t] = (QQQ Open[t-1] / QQQ Open[t-151]) - 1",
            "RV5[t] = stdev of prior 5 open-to-open returns",
            "RV7[t] = stdev of prior 7 open-to-open returns",
            "SMA63[t] = average QQQ Opens from t-1..t-63",
            "SMA126[t] = average QQQ Opens from t-1..t-126",
            "SR63_126[t] = SMA63[t] / SMA126[t]",
        ],
    }
    payload["plainEnglish"] = [
        "Stay invested when either the 20-day slope has dropped enough over the last 2 days OR 150-day momentum remains better than -1%.",
        "Short-term open-to-open volatility must stay low (RV5 and RV7 caps).",
        "The 63-day trend must not be too stretched above the 126-day trend.",
        "All indicators use prior data (t-1 and earlier), and trades are modeled open-to-open in TQQQ.",
    ]
    payload["backtest"] = {
        "cagr": "59.31%",
        "maxDrawdown": "-47.88%",
        "tradeCount": 61,
        "window": "2010-03-10 to 2025-08-20",
    }
    return payload


def reference_spxl_payload() -> dict:
    payload = empty_strategy_payload(
        "spxl",
        "SPXL Strategy",
        "SPY",
        "SPXL",
        "SPY signal, prior-data only, trade SPXL at today's open.",
    )
    payload["latestTradingDay"] = "2025-08-18"
    payload["currentActionText"] = "Live feed unavailable; showing reference strategy definition."
    payload["formula"] = {
        "buy": [
            "Buy when at least 3 of the 6 trend checks pass AND VR20/100 < 1.4.",
            "Checks: MOM90>0, MOM100>0, ABVMA100=true, SLP5_1>0, SLP20_1>0, SLP20_3>0.",
        ],
        "sell": [
            "Sell when score falls to 1 or 0, OR VR20/100 >= 1.4.",
        ],
        "definitions": [
            "MOM90 = (SPY Open[t-1] / SPY Open[t-91]) - 1",
            "MOM100 = (SPY Open[t-1] / SPY Open[t-101]) - 1",
            "ABVMA100 = SPY Open[t-1] > average of SPY Opens[t-1] through [t-100]",
            "SLP5_1 = (SMA5[t-1] / SMA5[t-2]) - 1",
            "SLP20_1 = (SMA20[t-1] / SMA20[t-2]) - 1",
            "SLP20_3 = (SMA20[t-1] / SMA20[t-4]) - 1",
            "VR20/100 = stdev(open-to-open returns over prior 20 days) / stdev(open-to-open returns over prior 100 days)",
        ],
    }
    payload["plainEnglish"] = [
        "Buy SPXL when trend breadth is strong (3+ of 6 checks true) and volatility regime is calm (VR20/100 < 1.4).",
        "Sell SPXL when breadth weakens to 1 or 0 checks, or volatility regime spikes (VR20/100 >= 1.4).",
        "All indicators use prior data (t-1 and earlier), and trades are modeled open-to-open in SPXL.",
    ]
    payload["backtest"] = {
        "cagr": "40.10%",
        "maxDrawdown": "-40.48%",
        "tradeCount": 56,
        "window": "2008-11-05 to 2025-08-18",
    }
    return payload


def load_existing_strategy_payload(path: Path, strategy_id: str) -> dict | None:
    if not path.exists():
        return None

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None

    if payload.get("id") != strategy_id:
        return None

    has_history = bool(payload.get("signalHistory"))
    has_live_signal = payload.get("currentSignal") not in {None, "", "N/A"}
    if not (has_history or has_live_signal):
        return None

    return payload

def main() -> None:
    run_ts = now_ny().strftime("%Y-%m-%d %H:%M:%S %Z")
    commit = os.getenv("GITHUB_SHA") or os.getenv("COMMIT_SHA") or "local"

    status = "OK"
    note = "Data refresh completed"
    row_counts: dict[str, int] = {}

    try:
        warnings: list[str] = []

        tqqq_existing = load_existing_strategy_payload(STRATEGY_DIR / "tqqq.json", "tqqq")
        try:
            qqq = get_daily_opens("QQQ")
            tqqq = get_daily_opens("TQQQ")
            row_counts["QQQ"] = int(len(qqq))
            row_counts["TQQQ"] = int(len(tqqq))
            tqqq_payload = tqqq_strategy(qqq, tqqq)
        except Exception as exc:
            warnings.append(f"TQQQ strategy update failed: {exc}")
            if tqqq_existing:
                tqqq_payload = tqqq_existing
                warnings.append("Kept previous successful TQQQ payload.")
            else:
                tqqq_payload = reference_tqqq_payload()
                warnings.append("Using reference TQQQ strategy payload from latest shared screenshot stats.")

        spxl_existing = load_existing_strategy_payload(STRATEGY_DIR / "spxl.json", "spxl")
        try:
            spy = get_daily_opens("SPY")
            spxl = get_daily_opens("SPXL")
            row_counts["SPY"] = int(len(spy))
            row_counts["SPXL"] = int(len(spxl))
            spxl_payload = spxl_strategy(spy, spxl)
        except Exception as exc:
            warnings.append(f"SPXL strategy update failed: {exc}")
            if spxl_existing:
                spxl_payload = spxl_existing
                warnings.append("Kept previous successful SPXL payload.")
            else:
                spxl_payload = reference_spxl_payload()
                warnings.append("Using reference SPXL strategy payload from latest shared screenshot stats.")

        latest_successful_refresh = run_ts if not warnings else None
        if warnings and (DATA_DIR / "current.json").exists():
            try:
                prev_current = json.loads((DATA_DIR / "current.json").read_text(encoding="utf-8"))
                latest_successful_refresh = prev_current.get("latestSuccessfulRefresh")
            except Exception:
                latest_successful_refresh = None

        current = {
            "siteTitle": "Dual Strategy Dashboard",
            "lastUpdated": run_ts,
            "latestTradingDay": max(
                [x for x in [tqqq_payload["latestTradingDay"], spxl_payload["latestTradingDay"]] if x] or [None]
            ),
            "latestSuccessfulRefresh": latest_successful_refresh,
            "strategies": [
                {
                    "id": tqqq_payload["id"],
                    "displayName": tqqq_payload["displayName"],
                    "sourceTicker": tqqq_payload["sourceTicker"],
                    "tradedTicker": tqqq_payload["tradedTicker"],
                    "currentSignal": tqqq_payload["currentSignal"],
                    "signalIsBuy": tqqq_payload["signalIsBuy"],
                    "currentActionText": tqqq_payload["currentActionText"],
                    "signalChangeSummary": tqqq_payload["signalChangeSummary"],
                    "streakType": tqqq_payload["streakType"],
                    "streakLength": tqqq_payload["streakLength"],
                    "latestOpen": tqqq_payload["latestOpen"],
                    "backtest": tqqq_payload["backtest"],
                },
                {
                    "id": spxl_payload["id"],
                    "displayName": spxl_payload["displayName"],
                    "sourceTicker": spxl_payload["sourceTicker"],
                    "tradedTicker": spxl_payload["tradedTicker"],
                    "currentSignal": spxl_payload["currentSignal"],
                    "signalIsBuy": spxl_payload["signalIsBuy"],
                    "currentActionText": spxl_payload["currentActionText"],
                    "signalChangeSummary": spxl_payload["signalChangeSummary"],
                    "streakType": spxl_payload["streakType"],
                    "streakLength": spxl_payload["streakLength"],
                    "latestOpen": spxl_payload["latestOpen"],
                    "backtest": spxl_payload["backtest"],
                },
            ],
        }

        (DATA_DIR / "current.json").write_text(json.dumps(current, indent=2), encoding="utf-8")
        (STRATEGY_DIR / "tqqq.json").write_text(json.dumps(tqqq_payload, indent=2), encoding="utf-8")
        (STRATEGY_DIR / "spxl.json").write_text(json.dumps(spxl_payload, indent=2), encoding="utf-8")

        # Backward compatibility for older readers.
        (DATA_DIR / "latest.json").write_text(json.dumps(tqqq_payload, indent=2), encoding="utf-8")
        (DATA_DIR / "history.json").write_text(json.dumps(tqqq_payload["signalHistory"], indent=2), encoding="utf-8")

        ensure_changelog()
        if warnings:
            status = "WARN"
            note = "; ".join(warnings)
    except Exception as exc:
        # Keep the job non-fatal: salvage existing payloads (or reference payloads)
        # and still write dashboard files/logs.
        status = "WARN"
        note = f"Refresh recovered from fatal error: {exc}"
        try:
            tqqq_payload = load_existing_strategy_payload(STRATEGY_DIR / "tqqq.json", "tqqq") or reference_tqqq_payload()
            spxl_payload = load_existing_strategy_payload(STRATEGY_DIR / "spxl.json", "spxl") or reference_spxl_payload()

            latest_successful_refresh = None
            if (DATA_DIR / "current.json").exists():
                try:
                    prev_current = json.loads((DATA_DIR / "current.json").read_text(encoding="utf-8"))
                    latest_successful_refresh = prev_current.get("latestSuccessfulRefresh")
                except Exception:
                    latest_successful_refresh = None

            current = {
                "siteTitle": "Dual Strategy Dashboard",
                "lastUpdated": run_ts,
                "latestTradingDay": max(
                    [x for x in [tqqq_payload.get("latestTradingDay"), spxl_payload.get("latestTradingDay")] if x]
                    or [None]
                ),
                "latestSuccessfulRefresh": latest_successful_refresh,
                "strategies": [
                    {
                        "id": tqqq_payload["id"],
                        "displayName": tqqq_payload["displayName"],
                        "sourceTicker": tqqq_payload["sourceTicker"],
                        "tradedTicker": tqqq_payload["tradedTicker"],
                        "currentSignal": tqqq_payload["currentSignal"],
                        "signalIsBuy": tqqq_payload["signalIsBuy"],
                        "currentActionText": tqqq_payload["currentActionText"],
                        "signalChangeSummary": tqqq_payload["signalChangeSummary"],
                        "streakType": tqqq_payload["streakType"],
                        "streakLength": tqqq_payload["streakLength"],
                        "latestOpen": tqqq_payload["latestOpen"],
                        "backtest": tqqq_payload["backtest"],
                    },
                    {
                        "id": spxl_payload["id"],
                        "displayName": spxl_payload["displayName"],
                        "sourceTicker": spxl_payload["sourceTicker"],
                        "tradedTicker": spxl_payload["tradedTicker"],
                        "currentSignal": spxl_payload["currentSignal"],
                        "signalIsBuy": spxl_payload["signalIsBuy"],
                        "currentActionText": spxl_payload["currentActionText"],
                        "signalChangeSummary": spxl_payload["signalChangeSummary"],
                        "streakType": spxl_payload["streakType"],
                        "streakLength": spxl_payload["streakLength"],
                        "latestOpen": spxl_payload["latestOpen"],
                        "backtest": spxl_payload["backtest"],
                    },
                ],
            }

            (DATA_DIR / "current.json").write_text(json.dumps(current, indent=2), encoding="utf-8")
            (STRATEGY_DIR / "tqqq.json").write_text(json.dumps(tqqq_payload, indent=2), encoding="utf-8")
            (STRATEGY_DIR / "spxl.json").write_text(json.dumps(spxl_payload, indent=2), encoding="utf-8")
            (DATA_DIR / "latest.json").write_text(json.dumps(tqqq_payload, indent=2), encoding="utf-8")
            (DATA_DIR / "history.json").write_text(
                json.dumps(tqqq_payload.get("signalHistory", []), indent=2),
                encoding="utf-8",
            )
            ensure_changelog()
            note = f"{note}; wrote fallback payloads."
        except Exception as salvage_exc:
            note = f"{note}; salvage write failed: {salvage_exc}"
    finally:
        latest_day = None
        if (DATA_DIR / "current.json").exists():
            try:
                latest_day = json.loads((DATA_DIR / "current.json").read_text(encoding="utf-8")).get(
                    "latestTradingDay"
                )
            except Exception:
                latest_day = None

        try:
            append_refresh_log(
                {
                    "timestamp": run_ts,
                    "type": "automated_refresh",
                    "status": status,
                    "latestTradingDay": latest_day,
                    "rowCounts": row_counts,
                    "note": note,
                    "commit": commit,
                    "source": "yFinance",
                }
            )
        except Exception as log_exc:
            print(f"Refresh log write failed: {log_exc}")

    print("Wrote strategy files, current.json, and refresh_log.json")


if __name__ == "__main__":
    main()
