# Re-Trace C++ adapter (Phase 2).
#
# Pipeline:
#   sample.cpp  --[python3 instrument.py (regex)]-->  *_inst.cpp  --[g++]-->  *  --[run]-->  *.trace.json
#
# Usage:
#   make                 # build all samples + run them -> trace JSON in samples/
#   make bubble_sort     # build & run a single sample
#   make clean
#
# Requires: g++ >= 9 (c++17) and python3.

CXX      ?= g++
CXXFLAGS ?= -std=c++17 -Wall -Wextra -Wno-unused-parameter -O0 -g
PY       ?= python3
INSTR     = $(abspath instrument.py)
INCL      = -I$(abspath .)

SAMPLES := bubble_sort factorial gcd_while

SRC   := $(patsubst %,samples/%.cpp,$(SAMPLES))
INST  := $(patsubst %,samples/%_inst.cpp,$(SAMPLES))
BIN   := $(patsubst %,samples/%,$(SAMPLES))
TRACE := $(patsubst %,samples/%.trace.json,$(SAMPLES))

.PHONY: all clean $(SAMPLES) check
.PRECIOUS: samples/%_inst.cpp samples/% samples/%.trace.json
all: $(TRACE)

# Per-sample convenience targets (end-to-end build + run).
$(SAMPLES): %: samples/%.trace.json

# Run the compiled binary; it writes the trace JSON itself via __RT_MAIN.
samples/%.trace.json: samples/%
	@echo "== run samples/$* =="
	cd samples && ./$*

# Compile the instrumented source. Header (./retrace.h) is on include path.
samples/%: samples/%_inst.cpp retrace.h
	$(CXX) $(CXXFLAGS) $(INCL) $< -o $@

# Instrument:  sample.cpp -> sample_inst.cpp
samples/%_inst.cpp: samples/%.cpp instrument.py
	$(PY) $(INSTR) $< -o $@

clean:
	rm -f $(INST) $(BIN) $(TRACE)
	rm -f samples/*.trace.json

check: all
	@echo "== trace shape check =="
	@for t in $(TRACE); do \
	  $(PY) -c "import json,sys;f=json.load(open('$$t'));s=f['steps'];\
	    ok=all(set(x)>={'line','depth','vars','loops','output','globalStep'} for x in s);\
	    print(f'{\"$$t\":30s} steps={len(s):3} lines={len(f[\"source\"][\"lines\"])} shape_ok={ok} last_out={s[-1][\"output\"].strip()!r}')"; \
	done
