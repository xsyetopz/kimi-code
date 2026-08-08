# kimi-next Makefile

.PHONY: test typecheck check help

help:
	@echo "make test | typecheck | check | help"

test:
	bunx vitest run

typecheck:
	bun run typecheck

check:
	bun run check
