from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

TIMEZONE = ZoneInfo("America/New_York")
STRATEGY_NAME = "(SSLP20_2 < -0.008 OR MOM150 > -0.01) AND RV5 < 0.03 AND RV7 < 0.03 AND SR63_126 < 1.05"


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

    df = df.copy()
    df.index = pd.to_datetime(pd.Index(idx).date)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    return df


def get_daily_opens(ticker: str) -> pd.DataFrame:
    daily = yf.Ticker(ticker).history(
        start="2000-01-01",
        interval="1d",
        auto_adjust=False,
        actions=False,
    )

    if daily.empty:
        raise RuntimeError(f"No daily data returned for {ticker}")

    daily = clean_date_index(daily)[["Open"]].dropna()
    daily.columns = [ticker]

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

            today_ny = datetime.now(TIMEZONE).date()
            intraday_today = intraday[intraday.index.date == today_ny]

            if not intraday_today.empty:
                regular_open_bar = intraday_today.between_time("09:30", "09:30")
                if not regular_open_bar.empty and pd.notna(regular_open_bar.iloc[0]["Open"]):
                    daily.loc[pd.Timestamp(today_ny), ticker] = float(regular_open_bar.iloc[0]["Open"])
                    daily = daily.sort_index()
    except Exception:
        pass

    return daily


def compute_indicators(qqq_opens: pd.Series) -> pd.DataFrame:
    df = pd.DataFrame(index=qqq_opens.index)
    df["qqq_open"] = qqq_opens.astype(float)

    # Prior-only calculations
    sma20 = df["qqq_open"].shift(1).rolling(20).mean()
    df["sslp20_2"] = sma20 / sma20.shift(2) - 1

    df["mom150"] = df["qqq_open"].shift(1) / df["qqq_open"].shift(151) - 1

    oo_ret = df["qqq_open"] / df["qqq_open"].shift(1) - 1
    df["rv5"] = oo_ret.shift(1).rolling(5).std(ddof=0)
    df["rv7"] = oo_ret.shift(1).rolling(7).std(ddof=0)

    sma63 = df["qqq_open"].shift(1).rolling(63).mean()
    sma126 = df["qqq_open"].shift(1).rolling(126).mean()
    df["sr63_126"] = sma63 / sma126

    df["signal"] = (
        ((df["sslp20_2"] < -0.008) | (df["mom150"] > -0.01))
        & (df["rv5"] < 0.03)
        & (df["rv7"] < 0.03)
        & (df["sr63_126"] < 1.05)
    ).fillna(False)

    return df


def simulate_strategy(etf_opens: pd.Series, signal: pd.Series) -> dict:
    sim = pd.DataFrame({"open": etf_opens.astype(float)}).join(
        signal.rename("position"), how="left"
    )
    sim["position"] = sim["position"].fillna(False).astype(int)
    sim = sim.dropna(subset=["open"]).copy()

    # If position[t] is 1, we hold from today's open to next day's open.
    sim["forward_ret"] = sim["open"].shift(-1) / sim["open"] - 1
    sim["strategy_ret"] = sim["position"] * sim["forward_ret"]

    valid = sim.dropna(subset=["strategy_ret"]).copy()
    if valid.empty:
        return {
            "cagr": None,
            "max_drawdown": None,
            "trades": 0,
            "window_start": None,
            "window_end": None,
        }

    equity = (1 + valid["strategy_ret"]).cumprod()
    drawdown = equity / equity.cummax() - 1

    days = max((valid.index[-1] - valid.index[0]).days, 1)
    cagr = float(equity.iloc[-1] ** (365.25 / days) - 1)
    trades = int(sim["position"].ne(sim["position"].shift(fill_value=0)).sum())

    return {
        "cagr": cagr,
        "max_drawdown": float(drawdown.min()),
        "trades": trades,
        "window_start": sim.index[0].strftime("%Y-%m-%d"),
        "window_end": valid.index[-1].strftime("%Y-%m-%d"),
    }


def pct_str(value: float | None) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"{value * 100:.2f}%"


def decimal_str(value: float | None, digits: int = 4) -> str:
    if value is None or pd.isna(value):
        return "N/A"
    return f"{value:.{digits}f}"


def build_json(ind: pd.DataFrame, tqqq: pd.Series, qld: pd.Series) -> tuple[dict, list[dict]]:
    latest = ind.dropna(subset=["sslp20_2", "mom150", "rv5", "rv7", "sr63_126"]).iloc[-1]
    latest_date = latest.name.strftime("%Y-%m-%d")

    tqqq_open = tqqq.reindex(ind.index).loc[latest.name]
    qld_open = qld.reindex(ind.index).loc[latest.name]

    tqqq_stats = simulate_strategy(tqqq.dropna(), ind["signal"])
    qld_stats = simulate_strategy(qld.dropna(), ind["signal"])

    indicators = [
        {
            "key": "sslp20_2",
            "label": "SSLP20_2",
            "display_value": pct_str(float(latest["sslp20_2"])),
            "raw_value": None if pd.isna(latest["sslp20_2"]) else float(latest["sslp20_2"]),
            "rule": "< -0.008",
            "passed": bool(latest["sslp20_2"] < -0.008),
            "description": "20-day SMA versus its value 2 trading days earlier (prior data only).",
        },
        {
            "key": "mom150",
            "label": "MOM150",
            "display_value": pct_str(float(latest["mom150"])),
            "raw_value": None if pd.isna(latest["mom150"]) else float(latest["mom150"]),
            "rule": "> -0.01",
            "passed": bool(latest["mom150"] > -0.01),
            "description": "QQQ Open[t-1] / QQQ Open[t-151] - 1.",
        },
        {
            "key": "rv5",
            "label": "RV5",
            "display_value": pct_str(float(latest["rv5"])),
            "raw_value": None if pd.isna(latest["rv5"]) else float(latest["rv5"]),
            "rule": "< 0.03",
            "passed": bool(latest["rv5"] < 0.03),
            "description": "Standard deviation of prior 5 QQQ open-to-open returns.",
        },
        {
            "key": "rv7",
            "label": "RV7",
            "display_value": pct_str(float(latest["rv7"])),
            "raw_value": None if pd.isna(latest["rv7"]) else float(latest["rv7"]),
            "rule": "< 0.03",
            "passed": bool(latest["rv7"] < 0.03),
            "description": "Standard deviation of prior 7 QQQ open-to-open returns.",
        },
        {
            "key": "sr63_126",
            "label": "SR63_126",
            "display_value": decimal_str(float(latest["sr63_126"]), 4),
            "raw_value": None if pd.isna(latest["sr63_126"]) else float(latest["sr63_126"]),
            "rule": "< 1.05",
            "passed": bool(latest["sr63_126"] < 1.05),
            "description": "63-day prior SMA divided by 126-day prior SMA.",
        },
    ]

    latest_json = {
        "strategy_name": STRATEGY_NAME,
        "subtitle": "QQQ signal, prior data only. Trades execute at today's open in TQQQ or QLD.",
        "last_updated": datetime.now(TIMEZONE).strftime("%Y-%m-%d %H:%M:%S %Z"),
        "latest_trading_day": latest_date,
        "market_signal": "BUY / INVESTED" if bool(latest["signal"]) else "CASH / OUT",
        "signal_is_buy": bool(latest["signal"]),
        "overview_cards": [
            {"label": "QQQ Open", "value": f"${float(latest['qqq_open']):.2f}"},
            {"label": "TQQQ Open", "value": "N/A" if pd.isna(tqqq_open) else f"${float(tqqq_open):.2f}"},
            {"label": "QLD Open", "value": "N/A" if pd.isna(qld_open) else f"${float(qld_open):.2f}"},
            {"label": "Latest Trading Day", "value": latest_date},
        ],
        "indicators": indicators,
        "formula_definitions": [
            "SMA20[t] = average of QQQ Opens from t-1 to t-20.",
            "SSLP20_2[t] = (SMA20[t] / SMA20[t-2]) - 1.",
            "MOM150[t] = (QQQ Open[t-1] / QQQ Open[t-151]) - 1.",
            "RV5[t] = standard deviation of prior 5 QQQ open-to-open returns.",
            "RV7[t] = standard deviation of prior 7 QQQ open-to-open returns.",
            "SR63_126[t] = prior 63-day SMA / prior 126-day SMA.",
        ],
        "plain_english": [
            "Stay invested when either the 20-day SMA has dropped enough over the last 2 trading days or 150-day momentum is better than -1%.",
            "Also require short-term open-to-open volatility to stay low.",
            "Also require the 63-day trend not to be too stretched above the 126-day trend.",
        ],
        "stats": {
            "TQQQ": {
                "cagr": pct_str(tqqq_stats["cagr"]),
                "max_drawdown": pct_str(tqqq_stats["max_drawdown"]),
                "trades": tqqq_stats["trades"],
                "window": f"{tqqq_stats['window_start']} to {tqqq_stats['window_end']}",
            },
            "QLD": {
                "cagr": pct_str(qld_stats["cagr"]),
                "max_drawdown": pct_str(qld_stats["max_drawdown"]),
                "trades": qld_stats["trades"],
                "window": f"{qld_stats['window_start']} to {qld_stats['window_end']}",
            },
        },
    }

    merged = pd.DataFrame(index=ind.index)
    merged["qqq_open"] = ind["qqq_open"]
    merged["tqqq_open"] = tqqq.reindex(ind.index)
    merged["qld_open"] = qld.reindex(ind.index)
    merged["signal"] = ind["signal"].astype(int)
    merged["sslp20_2"] = ind["sslp20_2"]
    merged["mom150"] = ind["mom150"]
    merged["rv5"] = ind["rv5"]
    merged["rv7"] = ind["rv7"]
    merged["sr63_126"] = ind["sr63_126"]

    history_rows = []
    for dt, row in merged.tail(320).iterrows():
        history_rows.append(
            {
                "date": dt.strftime("%Y-%m-%d"),
                "qqq_open": None if pd.isna(row["qqq_open"]) else round(float(row["qqq_open"]), 4),
                "tqqq_open": None if pd.isna(row["tqqq_open"]) else round(float(row["tqqq_open"]), 4),
                "qld_open": None if pd.isna(row["qld_open"]) else round(float(row["qld_open"]), 4),
                "signal": int(row["signal"]) if pd.notna(row["signal"]) else 0,
                "signal_text": "BUY" if int(row["signal"]) == 1 else "CASH",
                "sslp20_2": None if pd.isna(row["sslp20_2"]) else round(float(row["sslp20_2"]), 6),
                "mom150": None if pd.isna(row["mom150"]) else round(float(row["mom150"]), 6),
                "rv5": None if pd.isna(row["rv5"]) else round(float(row["rv5"]), 6),
                "rv7": None if pd.isna(row["rv7"]) else round(float(row["rv7"]), 6),
                "sr63_126": None if pd.isna(row["sr63_126"]) else round(float(row["sr63_126"]), 6),
            }
        )

    return latest_json, history_rows


def main() -> None:
    qqq = get_daily_opens("QQQ")
    tqqq = get_daily_opens("TQQQ")
    qld = get_daily_opens("QLD")

    ind = compute_indicators(qqq["QQQ"])
    latest_json, history_rows = build_json(ind, tqqq["TQQQ"], qld["QLD"])

    (DATA_DIR / "latest.json").write_text(json.dumps(latest_json, indent=2), encoding="utf-8")
    (DATA_DIR / "history.json").write_text(json.dumps(history_rows, indent=2), encoding="utf-8")

    print("Wrote data/latest.json and data/history.json")


if __name__ == "__main__":
    main()
