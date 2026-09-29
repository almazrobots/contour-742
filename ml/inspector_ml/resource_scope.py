"""Trusted, per-attempt allocation credits, shared by copied thread contexts.

The supervisor supplies the reservation; request payloads must never set it.
This guards rendered raster pixels, explicit raster/copy RAM credits and in-flight
output tokens. It is NOT an RSS/VRAM meter: model state, PDF internals, arbitrary
NumPy temporaries and input images decoded elsewhere need the process/cgroup
limit and conservative admission policy. The pilot forbids OCR/process fan-out.
Unsupervised legacy callers retain their existing behaviour.
"""
from contextlib import contextmanager
from contextvars import ContextVar
import math
from threading import RLock
import weakref

from .resource_admission import Resources


class ResourceBudgetExceeded(RuntimeError):
    pass


class _Budget:
    def __init__(self, resources):
        self.resources = resources
        self.lock = RLock()
        self.used = Resources()
        self.closed = False

    def check(self, demand):
        if self.closed:
            raise ResourceBudgetExceeded("supervised resource scope is closed")
        exceeded = (self.used + demand).exceeds(self.resources)
        if exceeded:
            raise ResourceBudgetExceeded("supervised resource budget exceeded: " + ",".join(exceeded))

    def reserve(self, demand):
        with self.lock:
            self.check(demand)
            self.used = self.used + demand
        return _Lease(self, demand)


class _Lease:
    def __init__(self, budget, demand):
        self.budget, self.demand, self.released = budget, demand, False

    def release(self):
        with self.budget.lock:
            if not self.released:
                self.budget.used = Resources(*(a - b for a, b in zip(self.budget.used.values(), self.demand.values())))
                self.released = True


_BUDGET: ContextVar[_Budget | None] = ContextVar("supervised_resource_budget", default=None)


@contextmanager
def supervised_resources(resources: Resources):
    if not isinstance(resources, Resources):
        raise ResourceBudgetExceeded("invalid supervised resource type")
    if _BUDGET.get() is not None:
        raise ResourceBudgetExceeded("nested supervised resource scope")
    budget = _Budget(resources)
    token = _BUDGET.set(budget)
    try:
        yield
    finally:
        with budget.lock:
            budget.closed = True
        _BUDGET.reset(token)


def is_supervised() -> bool:
    return _BUDGET.get() is not None


def _pixels(width, height, scale):
    for value in (width, height, scale):
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ResourceBudgetExceeded("invalid raster dimensions or scale")
    w, h = width * scale, height * scale
    if not math.isfinite(w) or not math.isfinite(h):
        raise ResourceBudgetExceeded("raster dimensions overflow")
    return math.ceil(w) * math.ceil(h)


def require_render_pixels(width, height, scale):
    budget = _BUDGET.get()
    if budget is None:
        return
    pixels = _pixels(width, height, scale)
    with budget.lock:
        budget.check(Resources())
        if pixels > budget.resources.pixels:
            raise ResourceBudgetExceeded("supervised resource budget exceeded: pixels")


def render_guarded(renderer, width, height, scale, *, bytes_per_pixel=16):
    """Reserve before rendering; retain credits for the returned raster's lifetime.

Default credits cover four RGBA-sized buffers, sheetdiff reserves sixteen.
Closing a PIL image alone does not release credits: destruction does. This can
reject conservatively, but cannot release while another reference remains.
"""
    budget = _BUDGET.get()
    if budget is None:
        return renderer()
    if type(bytes_per_pixel) is not int or bytes_per_pixel < 16:
        raise ResourceBudgetExceeded("raster copy credits must cover at least four RGBA buffers")
    pixels = _pixels(width, height, scale)
    lease = budget.reserve(Resources(pixels=pixels, ram=pixels * bytes_per_pixel))
    try:
        result = renderer()
        # PIL and NumPy arrays are weak-referenceable; a different return type
        # fails closed, rather than silently losing its allocation accounting.
        weakref.finalize(result, lease.release)
        return result
    except BaseException:
        lease.release()
        raise


def require_tokens(number):
    budget = _BUDGET.get()
    if budget is None:
        return
    if type(number) is not int or number <= 0:
        raise ResourceBudgetExceeded("invalid output token limit")
    with budget.lock:
        budget.check(Resources(tokens=number))


@contextmanager
def token_allocation(number):
    require_tokens(number)
    budget = _BUDGET.get()
    lease = budget.reserve(Resources(tokens=number)) if budget is not None else None
    try:
        yield
    finally:
        if lease is not None:
            lease.release()


def require_single_ocr_worker(workers, render_procs):
    if is_supervised() and (workers != 1 or render_procs != 0):
        raise ResourceBudgetExceeded("supervised pilot requires one OCR worker and no render subprocesses")
