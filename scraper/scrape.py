"""svel.ai poller — pulls Google Flights prices and posts them to the Worker.

Runs on GitHub Actions. Intentionally dumb: it fetches, normalises, and ships.
Every decision about alerting lives in the Worker.
"""

from __future__ import annotations

import os
import random
import sys
import time
from typing import Any

import requests
from fast_flights import FlightQuery, Passengers, create_query, get_flights

WORKER_URL = os.environ["WORKER_URL"].rstrip("/")
INGEST_TOKEN = os.environ["INGEST_TOKEN"]
AUTH = {"Authorization": f"Bearer {INGEST_TOKEN}"}
TIMEOUT = 45
RETRIES = 3


def fetch_routes() -> list[dict[str, Any]]:
    r = requests.get(f"{WORKER_URL}/routes", headers=AUTH, timeout=TIMEOUT)
    r.raise_for_status()
    return r.json()


def build_query(route: dict[str, Any]):
    legs = [
        FlightQuery(
            date=route["depart_date"],
            from_airport=route["origin"],
            to_airport=route["destination"],
        )
    ]
    trip = route.get("trip_type") or "round-trip"
    if trip == "round-trip" and route.get("return_date"):
        legs.append(
            FlightQuery(
                date=route["return_date"],
                from_airport=route["destination"],
                to_airport=route["origin"],
            )
        )
    else:
        trip = "one-way"

    return create_query(
        flights=legs,
        trip=trip,
        seat=route.get("seat") or "economy",
        passengers=Passengers(adults=int(route.get("adults") or 1)),
        currency=route.get("currency") or "USD",
        language="en",
        max_stops=route.get("max_stops"),
    )


def normalise(result) -> list[dict[str, Any]]:
    offers: list[dict[str, Any]] = []
    for f in result:
        price = getattr(f, "price", None)
        if not isinstance(price, int) or price <= 0:
            continue
        legs = getattr(f, "flights", []) or []
        # Google counts a connection per leg beyond the first, per direction.
        offers.append(
            {
                "price": price,
                "airlines": list(getattr(f, "airlines", []) or []),
                "stops": max(0, len(legs) - 1),
                "duration_min": sum(getattr(leg, "duration", 0) or 0 for leg in legs),
            }
        )
    return offers


def scrape(route: dict[str, Any]) -> tuple[bool, list[dict[str, Any]], str]:
    last_err = ""
    for attempt in range(1, RETRIES + 1):
        try:
            offers = normalise(get_flights(build_query(route)))
            if offers:
                return True, offers, ""
            last_err = "parsed page but found no priced itineraries"
        except Exception as exc:  # noqa: BLE001 — report every failure upstream
            last_err = f"{type(exc).__name__}: {exc}"
        if attempt < RETRIES:
            # Jittered backoff; Google throttles bursts from shared CI egress IPs.
            time.sleep(random.uniform(3, 8) * attempt)
    return False, [], last_err


def report(route_id: int, ok: bool, offers: list[dict[str, Any]], error: str) -> None:
    body = {"route_id": route_id, "ok": ok, "offers": offers, "error": error}
    r = requests.post(f"{WORKER_URL}/ingest", json=body, headers=AUTH, timeout=TIMEOUT)
    r.raise_for_status()
    print(f"  -> worker: {r.json()}")


def main() -> int:
    routes = fetch_routes()
    if not routes:
        print("No active routes. Add one via the Telegram bot: /add ...")
        return 0

    print(f"Polling {len(routes)} route(s)")
    failures = 0

    for route in routes:
        label = f"#{route['id']} {route['origin']}->{route['destination']} {route['depart_date']}"
        print(f"\n{label}")
        ok, offers, error = scrape(route)
        if ok:
            cheapest = min(o["price"] for o in offers)
            print(f"  {len(offers)} offers, cheapest {route['currency']} {cheapest}")
        else:
            failures += 1
            print(f"  FAILED: {error}")
        try:
            report(route["id"], ok, offers, error)
        except Exception as exc:  # noqa: BLE001
            print(f"  -> worker rejected the post: {exc}")
            failures += 1
        # Space out requests so a multi-route run doesn't look like a burst.
        time.sleep(random.uniform(2, 5))

    # Only fail the job if every route failed — one bad route shouldn't go red.
    if failures and failures >= len(routes):
        print(f"\nAll {len(routes)} route(s) failed.")
        return 1
    print(f"\nDone. {len(routes) - failures}/{len(routes)} route(s) succeeded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
