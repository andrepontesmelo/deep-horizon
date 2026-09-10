"""horizon-line Hermes plugin package.

Hermes loads a directory plugin by importing ``__init__.py`` and calling
``register(ctx)``: ``hermes_cli/plugins_loader.py`` refuses a plugin directory
without this file ("No __init__.py in ...") and then resolves the entry point
with ``getattr(module, "register", None)``. A plugin shipping only the module
file and ``plugin.yaml`` is discovered by ``hermes plugins list`` but never
registered — it silently injects nothing.

The implementation lives in :mod:`.horizon_line`; this module only re-exports
the entry point so the loader's package import works.
"""

from .horizon_line import register

__all__ = ["register"]
