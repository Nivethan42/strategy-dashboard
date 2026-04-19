from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import pandas_market_calendars as mcal
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
STRATEGY_DIR = DATA_DIR / "strategies"

DATA_DIR.mkdir(exist_ok=True)
STRATEGY_DIR.mkdir(parents=True, exist_ok=True)

TIMEZONE = ZoneInfo("America/New_York")
MAX_REFRESH_LOG_ROWS = 400
PROXY_ENV_VARS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)
TARGET_REFRESH_TIMES = {(9, 35), (9, 40), (9, 45)}


def now_ny() -> datetime:
    return datetime.now(TIMEZONE)


def is_nyse_open_day(dt: datetime) -> bool:
    nyse = mcal.get_calendar("XNYS")
    schedule = nyse.schedule(start_date=dt.date(), end_date=dt.date())
    return not schedule.empty


def should_run_scheduled_refresh(dt: datetime) -> tuple[bool, str]:
    if os.getenv("FORCE_REFRESH") == "1":
        return True, "FORCE_REFRESH=1"

    if not is_nyse_open_day(dt):
        return False, f"NYSE closed on {dt.date().isoformat()}"

    current_time = (dt.hour, dt.minute)
    if current_time not in TARGET_REFRESH_TIMES:
        return (
            False,
            "Current America/New_York time "
            f"{dt.strftime('%H:%M')} is outside scheduled refresh windows (09:35, 09:40, 09:45).",
        )

    return True, "Scheduled market-open refresh window"


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


def configure_yfinance_network() -> None:
    # Some runners inject proxy env vars that break yfinance's curl transport
    # with "CONNECT tunnel failed, response 403". Ensure yfinance calls Yahoo
    # directly from this refresh job.
    for key in PROXY_ENV_VARS:
        os.environ.pop(key, None)
    yf.config.network.proxy = None
    yf.config.network.retries = 3


def fetch_history(
    ticker: str,
    *,
    period: str | None = None,
    start: str | None = None,
    interval: str = "1d",
    auto_adjust: bool = False,
    actions: bool = False,
    prepost: bool = False,
    attempts: int = 3,
    pause_seconds: float = 1.0,
) -> pd.DataFrame:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            history = yf.Ticker(ticker).history(
                period=period,
                start=start,
                interval=interval,
                auto_adjust=auto_adjust,
                actions=actions,
                prepost=prepost,
            )
            if not history.empty:
                return history
        except Exception as exc:
            last_error = exc

        try:
            download = yf.download(
                tickers=ticker,
                period=period,
                start=start,
                interval=interval,
                auto_adjust=auto_adjust,
                actions=actions,
                prepost=prepost,
                progress=False,
                threads=False,
            )
            if isinstance(download, pd.DataFrame) and not download.empty:
                if isinstance(download.columns, pd.MultiIndex):
                    download = download.droplevel(-1, axis=1)
                return download
        except Exception as exc:
            last_error = exc

        if attempt < attempts:
            time.sleep(pause_seconds * attempt)

    if last_error:
        raise RuntimeError(f"Unable to fetch yfinance history for {ticker}: {last_error}") from last_error
    raise RuntimeError(f"No data returned for {ticker} after {attempts} attempts")


def get_daily_opens(ticker: str) -> pd.Series:
    # This strategy intentionally uses daily official open prices only.
    daily = fetch_history(
        ticker,
        start="2000-01-01",
        interval="1d",
        auto_adjust=False,
        actions=False,
    )

    if daily.empty:
        raise RuntimeError(f"No daily data returned for {ticker}")

    daily = clean_date_index(daily)[["Open"]].dropna()
    series = daily["Open"].astype(float).rename(ticker)

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

    sma7 = df["source_open"].shift(1).rolling(7).mean()
    df["sslp7_3"] = sma7 / sma7.shift(3) - 1
    ema100 = df["source_open"].ewm(span=100, adjust=False).mean().shift(1)
    df["eslp100_3"] = ema100 / ema100.shift(3) - 1
    df["mom100"] = df["source_open"].shift(1) / df["source_open"].shift(101) - 1
    df["mom180"] = df["source_open"].shift(1) / df["source_open"].shift(181) - 1
    sma150 = df["source_open"].shift(1).rolling(150).mean()
    sma200 = df["source_open"].shift(1).rolling(200).mean()
    df["sr150_200"] = sma150 / sma200
    sma50 = df["source_open"].shift(1).rolling(50).mean()
    df["sr50_150"] = sma50 / sma150
    sma63 = df["source_open"].shift(1).rolling(63).mean()
    sma126 = df["source_open"].shift(1).rolling(126).mean()
    df["sr63_126"] = sma63 / sma126

    df["signal"] = (
        (
            (df["sslp7_3"] < -0.02)
            | (df["eslp100_3"] < -0.006)
            | (df["mom100"] > -0.0225)
        )
        & (df["sr150_200"] < 1.07)
        & (df["sr63_126"] < 1.06)
        & (df["mom180"] > -0.12)
        & (df["sr50_150"] < 1.08)
    ).fillna(False).astype(int)

    latest_idx = df.dropna(subset=["sslp7_3", "eslp100_3", "mom100", "sr150_200", "sr63_126", "mom180", "sr50_150"]).index[-1]
    prev_idx = df.index[df.index.get_loc(latest_idx) - 1]

    latest_signal = int(df.loc[latest_idx, "signal"])
    prev_signal = int(df.loc[prev_idx, "signal"])
    changed_today = latest_signal != prev_signal

    stats, equity = simulate_strategy(tqqq_open, df["signal"])
    streak_type, streak_len = calculate_streak(df.loc[:latest_idx, "signal"])

    indicators = [
        {
            "key": "sslp7_3",
            "label": "SSLP7_3",
            "displayValue": pct_str(float(df.loc[latest_idx, "sslp7_3"])),
            "rawValue": float(df.loc[latest_idx, "sslp7_3"]),
            "rule": "< -0.02",
            "passed": bool(df.loc[latest_idx, "sslp7_3"] < -0.02),
            "description": "7-day SMA / same SMA from 3 trading days earlier - 1.",
        },
        {
            "key": "eslp100_3",
            "label": "ESLP100_3",
            "displayValue": pct_str(float(df.loc[latest_idx, "eslp100_3"])),
            "rawValue": float(df.loc[latest_idx, "eslp100_3"]),
            "rule": "< -0.006",
            "passed": bool(df.loc[latest_idx, "eslp100_3"] < -0.006),
            "description": "EMA100 / EMA100 from 3 trading days earlier - 1.",
        },
        {
            "key": "mom100",
            "label": "MOM100",
            "displayValue": pct_str(float(df.loc[latest_idx, "mom100"])),
            "rawValue": float(df.loc[latest_idx, "mom100"]),
            "rule": "> -0.0225",
            "passed": bool(df.loc[latest_idx, "mom100"] > -0.0225),
            "description": "QQQ Open[t-1] / QQQ Open[t-101] - 1.",
        },
        {
            "key": "sr150_200",
            "label": "SR150_200",
            "displayValue": num_str(float(df.loc[latest_idx, "sr150_200"])),
            "rawValue": float(df.loc[latest_idx, "sr150_200"]),
            "rule": "< 1.07",
            "passed": bool(df.loc[latest_idx, "sr150_200"] < 1.07),
            "description": "150-day prior SMA / 200-day prior SMA.",
        },
        {
            "key": "sr63_126",
            "label": "SR63_126",
            "displayValue": num_str(float(df.loc[latest_idx, "sr63_126"])),
            "rawValue": float(df.loc[latest_idx, "sr63_126"]),
            "rule": "< 1.06",
            "passed": bool(df.loc[latest_idx, "sr63_126"] < 1.06),
            "description": "63-day prior SMA / 126-day prior SMA.",
        },
        {
            "key": "mom180",
            "label": "MOM180",
            "displayValue": pct_str(float(df.loc[latest_idx, "mom180"])),
            "rawValue": float(df.loc[latest_idx, "mom180"]),
            "rule": "> -0.12",
            "passed": bool(df.loc[latest_idx, "mom180"] > -0.12),
            "description": "QQQ Open[t-1] / QQQ Open[t-181] - 1.",
        },
        {
            "key": "sr50_150",
            "label": "SR50_150",
            "displayValue": num_str(float(df.loc[latest_idx, "sr50_150"])),
            "rawValue": float(df.loc[latest_idx, "sr50_150"]),
            "rule": "< 1.08",
            "passed": bool(df.loc[latest_idx, "sr50_150"] < 1.08),
            "description": "50-day prior SMA / 150-day prior SMA.",
        },
    ]

    history = []
    joined_traded = tqqq_open.reindex(df.index)
    eq_aligned = equity.reindex(df.index)
    for dt, row in df.tail(11 * 252).iterrows():
        history.append(
            {
                "date": dt.strftime("%Y-%m-%d"),
                "sourceOpen": round(float(row["source_open"]), 4) if pd.notna(row["source_open"]) else None,
                "tradedOpen": round(float(joined_traded.loc[dt]), 4) if pd.notna(joined_traded.loc[dt]) else None,
                "signal": int(row["signal"]),
                "signalText": "BUY" if int(row["signal"]) == 1 else "CASH",
                "equity": round(float(eq_aligned.loc[dt]), 6) if pd.notna(eq_aligned.loc[dt]) else None,
                "sslp7_3": round(float(row["sslp7_3"]), 6) if pd.notna(row["sslp7_3"]) else None,
                "eslp100_3": round(float(row["eslp100_3"]), 6) if pd.notna(row["eslp100_3"]) else None,
                "mom100": round(float(row["mom100"]), 6) if pd.notna(row["mom100"]) else None,
                "sr150_200": round(float(row["sr150_200"]), 6) if pd.notna(row["sr150_200"]) else None,
                "sr63_126": round(float(row["sr63_126"]), 6) if pd.notna(row["sr63_126"]) else None,
                "mom180": round(float(row["mom180"]), 6) if pd.notna(row["mom180"]) else None,
                "sr50_150": round(float(row["sr50_150"]), 6) if pd.notna(row["sr50_150"]) else None,
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
                "(SSLP7_3 < -0.02 OR ESLP100_3 < -0.006 OR MOM100 > -0.0225) AND SR150_200 < 1.07 AND SR63_126 < 1.06 AND MOM180 > -0.12 AND SR50_150 < 1.08",
            ],
            "sell": [
                "Sell / go CASH when all trigger conditions fail (SSLP7_3 >= -0.02 AND ESLP100_3 >= -0.006 AND MOM100 <= -0.0225), or SR150_200 >= 1.07, or SR63_126 >= 1.06, or MOM180 <= -0.12, or SR50_150 >= 1.08.",
            ],
            "definitions": [
                "SMA7[t] = average of QQQ Opens from t-1..t-7",
                "SSLP7_3[t] = (SMA7[t] / SMA7[t-3]) - 1",
                "EMA100[t] = 100-day EMA of QQQ Opens using data up to t-1",
                "ESLP100_3[t] = (EMA100[t] / EMA100[t-3]) - 1",
                "MOM100[t] = (QQQ Open[t-1] / QQQ Open[t-101]) - 1",
                "SMA150[t] = average QQQ Opens from t-1..t-150",
                "SMA200[t] = average QQQ Opens from t-1..t-200",
                "SR150_200[t] = SMA150[t] / SMA200[t]",
                "SMA63[t] = average QQQ Opens from t-1..t-63",
                "SMA126[t] = average QQQ Opens from t-1..t-126",
                "SR63_126[t] = SMA63[t] / SMA126[t]",
                "MOM180[t] = (QQQ Open[t-1] / QQQ Open[t-181]) - 1",
                "SMA50[t] = average QQQ Opens from t-1..t-50",
                "SR50_150[t] = SMA50[t] / SMA150[t]",
            ],
        },
        "plainEnglish": [
            "Stay invested when the medium trend is not too stretched and long-term momentum is above -12%.",
            "At least one trigger must be supportive: 7-day slope softening, 100-day EMA slope softening below -0.6%, or 100-day momentum better than -2.25%.",
            "Trend filters require SR150_200 < 1.07, SR63_126 < 1.06, and SR50_150 < 1.08.",
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


def write_test_strategy_data(qqq: pd.Series, spy: pd.Series, tqqq: pd.Series, spxl: pd.Series) -> None:
    frame = pd.DataFrame(index=qqq.index.union(spy.index).union(tqqq.index).union(spxl.index)).sort_index()
    frame["qqqOpen"] = qqq.reindex(frame.index).astype(float)
    frame["spyOpen"] = spy.reindex(frame.index).astype(float)
    frame["tqqqOpen"] = tqqq.reindex(frame.index).astype(float)
    frame["spxlOpen"] = spxl.reindex(frame.index).astype(float)

    rows = []
    for idx, row in frame.iterrows():
        rows.append(
            {
                "date": idx.strftime("%Y-%m-%d"),
                "qqqOpen": round(float(row["qqqOpen"]), 6) if pd.notna(row["qqqOpen"]) else None,
                "spyOpen": round(float(row["spyOpen"]), 6) if pd.notna(row["spyOpen"]) else None,
                "tqqqOpen": round(float(row["tqqqOpen"]), 6) if pd.notna(row["tqqqOpen"]) else None,
                "spxlOpen": round(float(row["spxlOpen"]), 6) if pd.notna(row["spxlOpen"]) else None,
            }
        )

    payload = {
        "generatedAt": now_ny().strftime("%Y-%m-%d %H:%M:%S %Z"),
        "rows": rows,
    }
    (DATA_DIR / "test_strategy_data.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def write_test_strategy_data_from_payloads(tqqq_payload: dict, spxl_payload: dict) -> None:
    rows_by_date: dict[str, dict] = {}
    for row in tqqq_payload.get("signalHistory", []):
        d = row.get("date")
        if not d:
            continue
        rows_by_date.setdefault(d, {"date": d, "qqqOpen": None, "spyOpen": None, "tqqqOpen": None, "spxlOpen": None})
        rows_by_date[d]["qqqOpen"] = row.get("sourceOpen")
        rows_by_date[d]["tqqqOpen"] = row.get("tradedOpen")

    for row in spxl_payload.get("signalHistory", []):
        d = row.get("date")
        if not d:
            continue
        rows_by_date.setdefault(d, {"date": d, "qqqOpen": None, "spyOpen": None, "tqqqOpen": None, "spxlOpen": None})
        rows_by_date[d]["spyOpen"] = row.get("sourceOpen")
        rows_by_date[d]["spxlOpen"] = row.get("tradedOpen")

    payload = {
        "generatedAt": now_ny().strftime("%Y-%m-%d %H:%M:%S %Z"),
        "rows": [rows_by_date[k] for k in sorted(rows_by_date.keys())],
    }
    (DATA_DIR / "test_strategy_data.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


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
            "(SSLP7_3 < -0.02 OR ESLP100_3 < -0.006 OR MOM100 > -0.0225) AND SR150_200 < 1.07 AND SR63_126 < 1.06 AND MOM180 > -0.12 AND SR50_150 < 1.08",
        ],
        "sell": [
            "Sell / go CASH when all trigger conditions fail (SSLP7_3 >= -0.02 AND ESLP100_3 >= -0.006 AND MOM100 <= -0.0225), or SR150_200 >= 1.07, or SR63_126 >= 1.06, or MOM180 <= -0.12, or SR50_150 >= 1.08.",
        ],
        "definitions": [
            "SMA7[t] = average of QQQ Opens from t-1..t-7",
            "SSLP7_3[t] = (SMA7[t] / SMA7[t-3]) - 1",
            "EMA100[t] = 100-day EMA of QQQ Opens using data up to t-1",
            "ESLP100_3[t] = (EMA100[t] / EMA100[t-3]) - 1",
            "MOM100[t] = (QQQ Open[t-1] / QQQ Open[t-101]) - 1",
            "SMA150[t] = average QQQ Opens from t-1..t-150",
            "SMA200[t] = average QQQ Opens from t-1..t-200",
            "SR150_200[t] = SMA150[t] / SMA200[t]",
            "SMA63[t] = average QQQ Opens from t-1..t-63",
            "SMA126[t] = average QQQ Opens from t-1..t-126",
            "SR63_126[t] = SMA63[t] / SMA126[t]",
            "MOM180[t] = (QQQ Open[t-1] / QQQ Open[t-181]) - 1",
            "SMA50[t] = average QQQ Opens from t-1..t-50",
            "SR50_150[t] = SMA50[t] / SMA150[t]",
        ],
    }
    payload["plainEnglish"] = [
        "Stay invested when the medium trend is not too stretched and long-term momentum is above -12%.",
        "At least one trigger must be supportive: 7-day slope softening, 100-day EMA slope softening below -0.6%, or 100-day momentum better than -2.25%.",
        "Trend filters require SR150_200 < 1.07, SR63_126 < 1.06, and SR50_150 < 1.08.",
        "All indicators use prior data (t-1 and earlier), and trades are modeled open-to-open in TQQQ.",
    ]
    payload["backtest"] = {
        "cagr": "61.09%",
        "maxDrawdown": "-49.64%",
        "tradeCount": 131,
        "window": "2010-02-11 to 2026-04-10",
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
    run_dt = now_ny()
    run_ts = run_dt.strftime("%Y-%m-%d %H:%M:%S %Z")
    commit = os.getenv("GITHUB_SHA") or os.getenv("COMMIT_SHA") or "local"

    should_run, reason = should_run_scheduled_refresh(run_dt)
    if not should_run:
        append_refresh_log(
            {
                "timestamp": run_ts,
                "type": "automated_refresh",
                "status": "SKIP",
                "latestTradingDay": None,
                "rowCounts": {},
                "note": f"Skipped refresh: {reason}",
                "commit": commit,
                "source": "yFinance",
            }
        )
        print(f"Skipping refresh. {reason}")
        return

    status = "OK"
    note = "Data refresh completed"
    row_counts: dict[str, int] = {}

    try:
        configure_yfinance_network()
        warnings: list[str] = []

        qqq = None
        tqqq = None
        spy = None
        spxl = None

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
        if qqq is not None and tqqq is not None and spy is not None and spxl is not None:
            write_test_strategy_data(qqq, spy, tqqq, spxl)
        else:
            write_test_strategy_data_from_payloads(tqqq_payload, spxl_payload)

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
