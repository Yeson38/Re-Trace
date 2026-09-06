// =============================================================================
//  retrace.h — Re-Trace Phase 2 runtime (C++17, single-header)
//
//  User-side API (annotate user source manually, see samples/*.cpp):
//
//      int main() {
//          __RT_MAIN("out.trace.json");      // boots recorder, flushes atexit
//          ...
//      }
//      void foo(...) {
//          __RT_FN;                          // push call-depth on enter, pop on exit
//          ...
//      }
//
//  The instrumenter (instrument.py) additionally injects:
//
//      __RT_STEP(line);                  // one frame before each statement
//      __RT_VAR(line, name);             // register a locally-declared var in current depth
//      __RT_LOOP_BEGIN(Lid);             // push iteration counter (id = "L<line>")
//      __RT_LOOP_END(Lid);               // pop  iteration counter
//
//  The recorder implements the unified TraceStep protocol.
// =============================================================================
#ifndef RETRACE_H_
#define RETRACE_H_

// =======================================================
// Phase 4: Browser / WASM build path — trace flushed via JS callback.
// Desktop Tauri (native g++) keeps writing to disk (Phase 2 compat).
// =======================================================
#if defined(__EMSCRIPTEN__)
#  include <emscripten.h>
#  define RETRACE_WASM_BUILD 1
#  define RETRACE_EMSCRIPTEN 1
#elif defined(__WASM__) || defined(__wasm__) || defined(__wasi__)
// clang/wasi compilation: trace is written to the virtual filesystem as
// trace.json so the JS host (Wasmer SDK) can read it back. No EM_ASM.
#  define RETRACE_WASM_BUILD 1
#  define RETRACE_EMSCRIPTEN 0
#else
#  define RETRACE_WASM_BUILD 0
#  define RETRACE_EMSCRIPTEN 0
#endif

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <new>

#if RETRACE_WASM_BUILD
// ============================================================
// WASM build: ultra-lightweight C-style implementation.
// Templates (RtVec, RtMap) and deep class hierarchies are
// extremely slow to compile under WASM clang (5+ min), so the
// WASM path uses fixed arrays and minimal templates.
// ============================================================
namespace retrace {

// ---- Growable byte buffer ----
struct RtBuf {
  char* data = nullptr;
  size_t len = 0;
  size_t cap = 0;
  ~RtBuf() { if (data) std::free(data); }
  void reserve(size_t n) {
    if (cap >= n) return;
    cap = n + 32;
    data = (char*)std::realloc(data, cap);
  }
  void append(const char* s) {
    size_t n = std::strlen(s);
    reserve(len + n + 1);
    std::memcpy(data + len, s, n);
    len += n;
    data[len] = '\0';
  }
  void append(char c) {
    reserve(len + 2);
    data[len++] = c;
    data[len] = '\0';
  }
  void append(const char* s, size_t n) {
    reserve(len + n + 1);
    std::memcpy(data + len, s, n);
    len += n;
    data[len] = '\0';
  }
};

// ---- Fixed-capacity dynamic array (avoids template bloat) ----
struct RtStrVec {
  char** data = nullptr;
  size_t len = 0;
  size_t cap = 0;
  ~RtStrVec() {
    for (size_t i = 0; i < len; i++) if (data[i]) std::free(data[i]);
    if (data) std::free(data);
  }
  void push(const char* s) {
    if (len >= cap) {
      cap = cap ? cap * 2 : 8;
      data = (char**)std::realloc(data, cap * sizeof(char*));
    }
    size_t n = std::strlen(s ? s : "");
    char* copy = (char*)std::malloc(n + 1);
    std::memcpy(copy, s ? s : "", n + 1);
    data[len++] = copy;
  }
};

// ---- JSON string escaping ----
inline void rt_json_escape(RtBuf& out, const char* s) {
  out.append('"');
  for (; *s; s++) {
    switch (*s) {
      case '"':  out.append("\\\"", 2); break;
      case '\\': out.append("\\\\", 2); break;
      case '\n': out.append("\\n", 2); break;
      case '\r': out.append("\\r", 2); break;
      case '\t': out.append("\\t", 2); break;
      default:
        if ((unsigned char)*s < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", (unsigned char)*s);
          out.append(buf);
        } else {
          out.append(*s);
        }
    }
  }
  out.append('"');
}

// ---- to_json: serialize a value to JSON ----
inline void to_json(RtBuf& out, const char* v) { rt_json_escape(out, v ? v : ""); }
inline void to_json(RtBuf& out, char* v) { rt_json_escape(out, v ? v : ""); }
inline void to_json(RtBuf& out, bool v) { out.append(v ? "true" : "false"); }
inline void to_json(RtBuf& out, char v) { char b[16]; std::snprintf(b, sizeof(b), "%d", (int)v); out.append(b); }
inline void to_json(RtBuf& out, int v) { char b[32]; std::snprintf(b, sizeof(b), "%d", v); out.append(b); }
inline void to_json(RtBuf& out, unsigned v) { char b[32]; std::snprintf(b, sizeof(b), "%u", v); out.append(b); }
inline void to_json(RtBuf& out, long v) { char b[32]; std::snprintf(b, sizeof(b), "%ld", v); out.append(b); }
inline void to_json(RtBuf& out, unsigned long v) { char b[32]; std::snprintf(b, sizeof(b), "%lu", v); out.append(b); }
inline void to_json(RtBuf& out, long long v) { char b[32]; std::snprintf(b, sizeof(b), "%lld", v); out.append(b); }
inline void to_json(RtBuf& out, float v) { char b[64]; std::snprintf(b, sizeof(b), "%.9g", (double)v); out.append(b); }
inline void to_json(RtBuf& out, double v) { char b[64]; std::snprintf(b, sizeof(b), "%.9g", v); out.append(b); }
template <typename T, size_t N>
void to_json(RtBuf& out, const T (&v)[N]) {
  out.append('[');
  for (size_t i = 0; i < N; i++) { if (i) out.append(", "); to_json(out, v[i]); }
  out.append(']');
}
template <size_t N>
void to_json(RtBuf& out, const char (&v)[N]) { rt_json_escape(out, v); }
template <typename T>
void to_json(RtBuf& out, const T&) { out.append("\"<object>\""); }

// ---- Type name helper (no RTTI) ----
template <typename T>
const char* cxx_type_name() { return __PRETTY_FUNCTION__; }

// ---- Scope: holds variable registrations (parallel arrays, no map) ----
static const int RT_MAX_VARS = 64;
struct Scope {
  int depth = 0;
  const char* var_names[RT_MAX_VARS];
  const char* var_types[RT_MAX_VARS];
  const void* var_addrs[RT_MAX_VARS];
  void (*var_factories[RT_MAX_VARS])(const void*, RtBuf&);
  int var_count = 0;

  void reg(const char* name, const char* type, const void* addr,
           void (*factory)(const void*, RtBuf&)) {
    if (var_count >= RT_MAX_VARS) return;
    var_names[var_count] = name;
    var_types[var_count] = type;
    var_addrs[var_count] = addr;
    var_factories[var_count] = factory;
    var_count++;
  }
};

// ---- Step snapshot ----
struct Step {
  int line = 0;
  int depth = 0;
  int globalStep = 0;
  RtBuf output;
  // Variable snapshots (serialized JSON strings)
  RtStrVec var_names;
  RtStrVec var_types;
  RtStrVec var_values;
  // Loop counters
  RtStrVec loop_ids;
  int loop_currents[16] = {};
  int loop_totals[16] = {};
  int loop_count = 0;
};

// ---- Recorder ----
static const int RT_MAX_SCOPES = 32;
static const int RT_MAX_LOOPS = 16;
static const int RT_MAX_STEPS = 4096;

class Recorder {
 public:
  // Namespace-level static (defined below) avoids Meyers-singleton
  // __cxa_guard_* ABI calls, so no libc++ linking is needed.
  static Recorder& instance();
  Recorder() = default;

  void bootstrap(const char*, const char* src_name,
                 const char* const* src_lines, int src_n) {
    src_name_ = src_name ? src_name : "unknown.cpp";
    src_lines_ = src_lines;
    src_n_ = src_n;
  }

  void push_scope(const char* = "") {
    if (scope_count_ < RT_MAX_SCOPES) {
      scopes_[scope_count_].depth = scope_count_ ? scopes_[scope_count_ - 1].depth + 1 : 1;
      scopes_[scope_count_].var_count = 0;
      scope_count_++;
    }
  }
  void pop_scope() { if (scope_count_) scope_count_--; }
  int current_depth() { return scope_count_ ? scopes_[scope_count_ - 1].depth : 1; }

  template <typename T>
  void reg_var(const char* name, const T& storage) {
    if (scope_count_ == 0) push_scope();
    Scope& s = scopes_[scope_count_ - 1];
    s.reg(name, cxx_type_name<T>(), &storage,
          +[](const void* p, RtBuf& o) { to_json<T>(o, *static_cast<const T*>(p)); });
  }

  void loop_push(const char* id) {
    if (loop_count_ < RT_MAX_LOOPS) {
      loop_ids_[loop_count_] = id;
      loop_currents_[loop_count_] = 0;
      loop_totals_[loop_count_] = 0;
      loop_count_++;
    }
  }
  void loop_increment_entry(const char* id) {
    for (int i = loop_count_ - 1; i >= 0; i--) {
      if (std::strcmp(loop_ids_[i], id) == 0) {
        loop_currents_[i]++;
        if (loop_totals_[i] < loop_currents_[i] + 1)
          loop_totals_[i] = loop_currents_[i] + 1;
        return;
      }
    }
  }
  void loop_set_total(const char* id, int total) {
    for (int i = 0; i < loop_count_; i++)
      if (std::strcmp(loop_ids_[i], id) == 0) loop_totals_[i] = total;
  }
  void loop_pop(const char* id) {
    for (int i = 0; i < loop_count_; i++) {
      if (std::strcmp(loop_ids_[i], id) == 0) {
        for (int j = i; j + 1 < loop_count_; j++) {
          loop_ids_[j] = loop_ids_[j + 1];
          loop_currents_[j] = loop_currents_[j + 1];
          loop_totals_[j] = loop_totals_[j + 1];
        }
        loop_count_--;
        return;
      }
    }
  }

  void step_record(int line, const char* entering_loop_id = nullptr) {
    if (step_count_ >= RT_MAX_STEPS) return;
    if (entering_loop_id) loop_increment_entry(entering_loop_id);
    Step& st = steps_[step_count_];
    st.line = line;
    st.depth = current_depth();
    st.globalStep = step_count_;
    st.var_names.len = 0; st.var_types.len = 0; st.var_values.len = 0;
    for (int si = 0; si < scope_count_; si++) {
      Scope& scope = scopes_[si];
      for (int vi = 0; vi < scope.var_count; vi++) {
        st.var_names.push(scope.var_names[vi]);
        st.var_types.push(scope.var_types[vi]);
        RtBuf jb;
        scope.var_factories[vi](scope.var_addrs[vi], jb);
        st.var_values.push(jb.data ? jb.data : "null");
      }
    }
    st.loop_ids.len = 0;
    st.loop_count = loop_count_;
    for (int i = 0; i < loop_count_; i++) {
      st.loop_ids.push(loop_ids_[i]);
      st.loop_currents[i] = loop_currents_[i];
      st.loop_totals[i] = loop_totals_[i];
    }
    step_count_++;
  }

  void flush_to_disk() {
    if (flushed_) return;
    flushed_ = true;
    FILE* f = std::fopen("trace.json", "wb");
    if (!f) return;
    write_json(f);
    std::fclose(f);
  }

 private:
  void write_json(FILE* f) {
    std::fprintf(f, "{\n  \"source\": {\n");
    const char* sn = src_name_;
    const char* slash = std::strrchr(sn, '/');
    if (slash) sn = slash + 1;
    RtBuf nb; rt_json_escape(nb, sn);
    std::fprintf(f, "    \"name\": %s,\n", nb.data ? nb.data : "\"\"");
    std::fprintf(f, "    \"language\": \"cpp\",\n    \"lines\": [");
    for (int i = 0; i < src_n_; i++) {
      RtBuf lb; rt_json_escape(lb, src_lines_[i] ? src_lines_[i] : "");
      std::fprintf(f, "%s\n      %s", i == 0 ? "" : ",", lb.data ? lb.data : "\"\"");
    }
    std::fprintf(f, "\n    ]\n  },\n  \"steps\": [");
    for (int i = 0; i < step_count_; i++) {
      std::fprintf(f, "%s\n", i == 0 ? "" : ",");
      write_step(f, steps_[i], "    ");
    }
    if (step_count_) std::fprintf(f, "\n  ");
    std::fprintf(f, "]\n}\n");
  }

  static void write_step(FILE* f, const Step& s, const char* pad) {
    std::fprintf(f, "%s{\n", pad);
    std::fprintf(f, "%s  \"line\": %d,\n", pad, s.line);
    std::fprintf(f, "%s  \"depth\": %d,\n", pad, s.depth);
    std::fprintf(f, "%s  \"vars\": [", pad);
    for (int i = 0; i < s.var_names.len; i++) {
      if (i) std::fprintf(f, ",");
      RtBuf n, t, v;
      rt_json_escape(n, s.var_names.data[i]);
      rt_json_escape(t, s.var_types.data[i]);
      rt_json_escape(v, s.var_values.data[i]);
      std::fprintf(f, "\n%s    {\"name\": %s, \"value\": %s, \"type\": %s}",
                   pad, n.data, v.data, t.data);
    }
    if (s.var_names.len) std::fprintf(f, "\n%s  ", pad);
    std::fprintf(f, "],\n");
    std::fprintf(f, "%s  \"loops\": [", pad);
    for (int i = 0; i < s.loop_count; i++) {
      if (i) std::fprintf(f, ",");
      RtBuf ib; rt_json_escape(ib, s.loop_ids.data[i]);
      std::fprintf(f, "{\"id\": %s, \"current\": %d, \"total\": %d}",
                   ib.data, s.loop_currents[i], s.loop_totals[i]);
    }
    std::fprintf(f, "],\n");
    RtBuf ob; rt_json_escape(ob, s.output.data ? s.output.data : "");
    std::fprintf(f, "%s  \"output\": %s,\n", pad, ob.data ? ob.data : "\"\"");
    std::fprintf(f, "%s  \"globalStep\": %d\n", pad, s.globalStep);
    std::fprintf(f, "%s}", pad);
  }

  bool flushed_ = false;
  const char* src_name_ = "unknown.cpp";
  const char* const* src_lines_ = nullptr;
  int src_n_ = 0;
  Scope scopes_[RT_MAX_SCOPES];
  int scope_count_ = 0;
  const char* loop_ids_[RT_MAX_LOOPS];
  int loop_currents_[RT_MAX_LOOPS] = {};
  int loop_totals_[RT_MAX_LOOPS] = {};
  int loop_count_ = 0;
  Step steps_[RT_MAX_STEPS];
  int step_count_ = 0;
};

// Namespace-level singleton instance (no __cxa_guard needed).
static Recorder g_retrace_recorder;
inline Recorder& Recorder::instance() { return g_retrace_recorder; }

struct ScopeGuard {
  ScopeGuard() { Recorder::instance().push_scope(); }
  explicit ScopeGuard(const char* fn) { Recorder::instance().push_scope(fn); }
  ~ScopeGuard() { Recorder::instance().pop_scope(); }
};

struct BootstrapGuard {
  BootstrapGuard(const char* json_path, const char* src_name,
                 const char* const* src_lines, int src_n) {
    Recorder::instance().bootstrap(json_path, src_name, src_lines, src_n);
    Recorder::instance().push_scope("main");
  }
  ~BootstrapGuard() {
    Recorder::instance().pop_scope();
    Recorder::instance().flush_to_disk();
  }
};

struct LoopGuard {
  const char* id;
  explicit LoopGuard(const char* id_) : id(id_) {
    Recorder::instance().loop_push(id);
  }
  ~LoopGuard() { Recorder::instance().loop_pop(id); }
};

}  // namespace retrace

#else  // !RETRACE_WASM_BUILD
// ============================================================
// Native build: full STL implementation (Phase 2 compat).
// ============================================================
#include <any>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <stack>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <typeinfo>
#include <utility>
#include <vector>

namespace retrace {
namespace fs = std::filesystem;

// ---------------------------------------------------------------------------
// Value serialization
// ---------------------------------------------------------------------------
struct VarEntry {
    std::string name;
    std::string type;
    // value is stored either as serialized string or as the real any for
    // pretty-printing; we always serialize to a JSON-compatible string for
    // stability across types.
    std::string json;
};

// Fallback for unsupported T: just stringify via operator<< if possible.
template <typename, typename = void> struct has_ostream : std::false_type {};
template <typename T>
struct has_ostream<T, std::void_t<decltype(std::declval<std::ostream&>() << std::declval<const T&>())>> : std::true_type {};

// Detect iterable containers (vector, list, array, set, map, ...) but NOT
// std::string (already handled as a string above).
template <typename, typename = void> struct is_iterable_container : std::false_type {};
template <typename T>
struct is_iterable_container<T, std::void_t<
    decltype(std::declval<const T&>().begin()),
    decltype(std::declval<const T&>().end())
>> : std::conditional_t<
        std::is_same_v<T, std::string> || std::is_same_v<T, const char*>,
        std::false_type,
        std::true_type
     > {};

// True if the element type is a std::pair-like type with first/second members
// and ::first_type / ::second_type typenames (e.g. std::map's value_type).
template <typename, typename = void> struct is_kv_element : std::false_type {};
template <typename E>
struct is_kv_element<E, std::void_t<
    typename E::first_type,
    typename E::second_type,
    decltype(std::declval<const E&>().first),
    decltype(std::declval<const E&>().second)
>> : std::true_type {};

template <typename T>
std::string to_json(const T& v) {
    if constexpr (std::is_same_v<T, std::string>) {
        std::ostringstream o;
        o << std::quoted(v);
        return o.str();
    } else if constexpr (std::is_same_v<T, const char*>) {
        std::ostringstream o;
        o << std::quoted(std::string(v ? v : ""));
        return o.str();
    } else if constexpr (std::is_same_v<T, bool>) {
        return v ? "true" : "false";
    } else if constexpr (std::is_null_pointer_v<T> || std::is_same_v<T, std::nullptr_t>) {
        return "null";
    } else if constexpr (std::is_arithmetic_v<T>) {
        std::ostringstream o;
        if constexpr (std::is_floating_point_v<T>) {
            o << std::setprecision(9) << v;
        } else {
            o << v;
        }
        return o.str();
    } else if constexpr (std::is_same_v<T, char>) {
        // char: treat as int so `'a'` -> "97" like Python's `ord`.
        return std::to_string(static_cast<int>(v));
    } else if constexpr (std::is_pointer_v<T>) {
        std::ostringstream o;
        if (v == nullptr) return "null";
        // string char*?
        if constexpr (std::is_same_v<std::remove_const_t<std::remove_pointer_t<T>>, char>) {
            return to_json<std::string>(v);
        }
        o << "\"<ptr 0x" << std::hex << (uintptr_t)v << ">\"";
        return o.str();
    } else if constexpr (is_iterable_container<T>::value) {
        using Elem = std::decay_t<decltype(*std::declval<const T&>().begin())>;
        constexpr bool kIsMap = is_kv_element<Elem>::value;
        std::ostringstream o;
        bool first = true;
        if constexpr (kIsMap) {
            o << "{";
            for (const auto& kv : v) {
                if (!first) o << ", ";
                first = false;
                std::ostringstream keyo;
                keyo << kv.first;
                o << std::quoted(keyo.str()) << ": " << to_json(kv.second);
            }
            o << "}";
        } else {
            o << "[";
            for (const auto& item : v) {
                if (!first) o << ", ";
                first = false;
                o << to_json(item);
            }
            o << "]";
        }
        return o.str();
    } else {
        if constexpr (has_ostream<T>::value) {
            std::ostringstream o;
            o << v;
            std::string s = o.str();
            // Quote unless it's already valid JSON (number/null/bool quoted).
            // Heuristic: if not starting with digit/minus/brace and not a
            // boolean literal, wrap in quotes.
            bool num = (!s.empty() && (s[0] == '-' || s[0] == '.' || (s[0] >= '0' && s[0] <= '9')));
            if (num || s == "true" || s == "false" || s == "null" ||
                (s.size() >= 2 && ((s.front() == '"' && s.back() == '"') ||
                                   (s.front() == '[' && s.back() == ']') ||
                                   (s.front() == '{' && s.back() == '}')))) {
                return s;
            }
            std::ostringstream q;
            q << std::quoted(s);
            return q.str();
        } else {
            return "\"<object>\"";
        }
    }
}

template <typename T, typename = void> struct cxx_type_name {
    static std::string get() {
#if defined(__GNUC__) || defined(__clang__)
        std::string s = __PRETTY_FUNCTION__;
        // __PRETTY_FUNCTION__ contains: [with T = XXX; ...]
        auto a = s.find("T = ");
        if (a == std::string::npos) return typeid(T).name();
        a += 4;
        auto b = s.find(";", a);
        if (b == std::string::npos) b = s.find("]", a);
        return s.substr(a, b - a);
#else
        return typeid(T).name();
#endif
    }
};

// ---------------------------------------------------------------------------
// Loop counter stack
// ---------------------------------------------------------------------------
struct LoopCounter {
    std::string id;
    int current = 0;  // 0-based iteration just entered when first body statement hits
    int total = 0;    // 0 = unknown (while / iterator without size)
};

// ---------------------------------------------------------------------------
// Depth tracking & scope variables
// ---------------------------------------------------------------------------
struct Scope {
    int depth = 0;
    // Registered variables: name -> (type, getter-as-string closure).
    // We hold pointers to the real locals. The address is stable for the
    // lifetime of the function/block where the declaration occurred, which
    // covers the window during which any STEP inside that scope runs.
    std::map<std::string, std::pair<std::string, const void*>> vars;  // name -> (type, &storage)
    // Each registered var additionally stores a serializer function by ID,
    // keyed by (depth, name) to allow redeclared shadowing. We use an ordered
    // map over (name, type-erased to_json factory).
    using Factory = std::string (*)(const void*);
    std::map<std::string, Factory> factories;
};

// ---------------------------------------------------------------------------
// Per-step structure written by flush().
// ---------------------------------------------------------------------------
struct Step {
    int line = 0;
    int depth = 0;
    std::vector<VarEntry> vars;
    std::vector<LoopCounter> loops;
    std::string output;
    int globalStep = 0;
};

// ---------------------------------------------------------------------------
// Recorder (singleton)
// ---------------------------------------------------------------------------
class Recorder {
  public:
    static Recorder& instance() {
        static Recorder inst;
        return inst;
    }

    // Called once from __RT_MAIN macro before the first step.
    void bootstrap(const char* json_path, const char* src_name,
                   const char* const* src_lines, int src_n) {
        std::lock_guard<std::mutex> lk(mu_);
        if (bootstrapped_) return;
        bootstrapped_ = true;
        output_path_ = json_path ? json_path : "trace.json";
        src_name_ = src_name ? src_name : "unknown.cpp";
        src_lines_.resize(src_n);
        for (int i = 0; i < src_n; ++i) src_lines_[i] = src_lines[i] ? src_lines[i] : "";

        // Capture real stdout (cout/cstdio) and redirect to string buffer.
        real_buf_ = std::cout.rdbuf();
        std::cout.rdbuf(capture_.rdbuf());
        // Also redirect stdout for printf-style IO (common in OI code).
        ::fflush(stdout);
        ::setvbuf(stdout, nullptr, _IOFBF, BUFSIZ);  // reset to buffered
        stdout_capture_on_ = true;

        std::atexit([](){ Recorder::instance().flush_to_disk(); });
    }

    // ----- scope helpers --------------------------------------------------
    void push_scope(const char* /*fn_name*/ = "") {
        std::lock_guard<std::mutex> lk(mu_);
        Scope s;
        s.depth = scopes_.empty() ? 1 : (scopes_.back().depth + 1);
        scopes_.push_back(s);
    }
    void pop_scope() {
        std::lock_guard<std::mutex> lk(mu_);
        if (!scopes_.empty()) scopes_.pop_back();
    }
    Scope& top_scope() {
        if (scopes_.empty()) {
            // Safety: create depth-1 scope (shouldn't happen with proper main/fn markers).
            scopes_.push_back(Scope{1, {}, {}});
        }
        return scopes_.back();
    }
    int current_depth() {
        if (scopes_.empty()) return 1;
        return scopes_.back().depth;
    }

    // Register a variable binding in the current (top) scope.
    template <typename T>
    void reg_var(const char* name, const T& storage) {
        std::lock_guard<std::mutex> lk(mu_);
        auto& s = top_scope();
        s.vars[name] = std::make_pair(cxx_type_name<T>::get(),
                                      static_cast<const void*>(&storage));
        s.factories[name] = +[](const void* p) -> std::string {
            return to_json<T>(*static_cast<const T*>(p));
        };
    }

    // ----- loop stack ----------------------------------------------------
    void loop_push(const std::string& id) {
        std::lock_guard<std::mutex> lk(mu_);
        LoopCounter c;
        c.id = id;
        loop_stack_.push_back(c);
    }
    void loop_increment_entry(const std::string& id) {
        std::lock_guard<std::mutex> lk(mu_);
        // Called at the first statement of the body: bump current for the
        // top loop matching this id. We match by string on top first.
        for (auto it = loop_stack_.rbegin(); it != loop_stack_.rend(); ++it) {
            if (it->id == id) {
                it->current += 1;
                // while-loops (unknown total) grow; for-loops also grow to
                // at least current so progress bar shows something real.
                if (it->total < it->current + 1) it->total = it->current + 1;
                return;
            }
        }
    }
    void loop_set_total(const std::string& id, int total) {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto& c : loop_stack_) if (c.id == id) c.total = total;
    }
    void loop_pop(const std::string& id) {
        std::lock_guard<std::mutex> lk(mu_);
        for (auto it = loop_stack_.rbegin(); it != loop_stack_.rend(); ++it) {
            if (it->id == id) {
                // erase by converting reverse<->forward iterators.
                loop_stack_.erase(std::next(it).base());
                return;
            }
        }
    }

    // ----- step recording ------------------------------------------------
    void step_record(int line, const std::string& entering_loop_id = {}) {
        std::lock_guard<std::mutex> lk(mu_);
        if (!entering_loop_id.empty()) {
            // Bump loop counter for this loop id (pre-body entry bump).
            for (auto& c : loop_stack_) if (c.id == entering_loop_id) {
                c.current += 1;
                if (c.total < c.current + 1) c.total = c.current + 1;
            }
        }
        // Attribute stdout produced by the PREVIOUS step onto it.
        std::string pending = capture_.str();
        if (!pending.empty()) {
            capture_.str("");
            capture_.clear();
            if (!steps_.empty()) {
                steps_.back().output += pending;
            } else {
                // Output before any step is rare; attach as pending and flush
                // at the first step.
                pre_step_output_ += pending;
            }
        }
        Step st;
        st.line = line;
        st.depth = current_depth();
        st.globalStep = (int)steps_.size();

        // Gather vars: all scopes from bottom (global) to top, so inner
        // scopes shadow outer ones on equal name.
        std::map<std::string, VarEntry> merged;
        for (auto& scope : scopes_) {
            for (auto& [nm, pair] : scope.vars) {
                VarEntry e;
                e.name = nm;
                e.type = pair.first;
                auto fit = scope.factories.find(nm);
                if (fit != scope.factories.end()) {
                    e.json = fit->second(pair.second);
                } else {
                    e.json = "null";
                }
                merged[nm] = e;
            }
        }
        st.vars.reserve(merged.size());
        for (auto& [_, e] : merged) st.vars.push_back(e);

        st.loops = loop_stack_;

        if (!pre_step_output_.empty()) {
            st.output = std::move(pre_step_output_);
            pre_step_output_.clear();
        }
        steps_.push_back(std::move(st));
    }

    // Flush trailing stdout and write trace.json.
    void flush_to_disk() {
        std::lock_guard<std::mutex> lk(mu_);
        if (flushed_) return;
        flushed_ = true;

        // Restore cout so user atexit prints are not captured.
        if (real_buf_) {
            std::cout.rdbuf(real_buf_);
            real_buf_ = nullptr;
        }
        stdout_capture_on_ = false;

        std::string pending = capture_.str();
        capture_.str("");
        capture_.clear();
        if (!pending.empty() && !steps_.empty()) {
            steps_.back().output += pending;
        }

#if RETRACE_EMSCRIPTEN
        // Emscripten build: emit JSON string directly via JS callback.
        // Routes to BrowserRecorderService window.__retrace_emit listener.
        std::ostringstream oss;
        write_json(oss);
        std::string json = oss.str();
        EM_ASM_INT({
            const char* s = reinterpret_cast<const char*>($0);
            if (typeof window !== 'undefined' && typeof window.__retrace_emit === 'function') {
                window.__retrace_emit(UTF8ToString(s));
            } else if (typeof window !== 'undefined') {
                window.__retrace_last = UTF8ToString(s);
            }
        }, json.c_str());
#elif RETRACE_WASM_BUILD
        // clang -target wasm32-wasi build: write trace.json to the virtual
        // filesystem. The JS host reads it back via Wasmer SDK readFile.
        fs::path p = "trace.json";
        std::ofstream f(p, std::ios::out | std::ios::binary);
        if (f) {
            write_json(f);
            f.close();
        }
#else
        // Desktop / original Phase 2 disk-write path.
        fs::path p = output_path_;
        if (!p.is_absolute()) p = fs::current_path() / p;
        std::error_code ec;
        fs::create_directories(p.parent_path(), ec);

        std::ofstream f(p, std::ios::out | std::ios::binary);
        if (!f) {
            std::cerr << "[retrace] Failed to open " << p << " for writing\n";
            return;
        }
        write_json(f);
#endif
    }

  private:
    Recorder() = default;

    void write_json(std::ostream& out) {
        out << "{\n";
        out << "  \"source\": {\n";
        out << "    \"name\": " << json_quote(fs::path(src_name_).filename().string()) << ",\n";
        out << "    \"language\": \"cpp\",\n";
        out << "    \"lines\": [";
        for (size_t i = 0; i < src_lines_.size(); ++i) {
            out << (i == 0 ? "\n" : ",\n") << "      " << json_quote(src_lines_[i]);
        }
        out << "\n    ]\n";
        out << "  },\n";
        out << "  \"steps\": [";
        for (size_t i = 0; i < steps_.size(); ++i) {
            out << (i == 0 ? "\n" : ",\n");
            write_step(out, steps_[i], "    ");
        }
        if (!steps_.empty()) out << "\n  ";
        out << "]\n}\n";
    }

    static void write_step(std::ostream& out, const Step& s, const std::string& pad) {
        out << pad << "{\n";
        out << pad << "  \"line\": " << s.line << ",\n";
        out << pad << "  \"depth\": " << s.depth << ",\n";
        out << pad << "  \"vars\": [";
        for (size_t i = 0; i < s.vars.size(); ++i) {
            out << (i == 0 ? "\n" : ",\n");
            out << pad << "    {\"name\": " << json_quote(s.vars[i].name)
                << ", \"value\": " << s.vars[i].json
                << ", \"type\": " << json_quote(s.vars[i].type) << "}";
        }
        if (!s.vars.empty()) out << "\n" << pad << "  ";
        out << "],\n";
        out << pad << "  \"loops\": [";
        for (size_t i = 0; i < s.loops.size(); ++i) {
            if (i) out << ",";
            out << "{\"id\": " << json_quote(s.loops[i].id)
                << ", \"current\": " << s.loops[i].current
                << ", \"total\": " << s.loops[i].total << "}";
        }
        out << "],\n";
        out << pad << "  \"output\": " << json_quote(s.output) << ",\n";
        out << pad << "  \"globalStep\": " << s.globalStep << "\n";
        out << pad << "}";
    }

    static std::string json_quote(const std::string& s) {
        std::ostringstream o;
        o << '"';
        for (char c : s) {
            switch (c) {
                case '"':  o << "\\\""; break;
                case '\\': o << "\\\\"; break;
                case '\n': o << "\\n"; break;
                case '\r': o << "\\r"; break;
                case '\t': o << "\\t"; break;
                default:
                    if ((unsigned char)c < 0x20) {
                        o << "\\u00" << std::hex << std::setfill('0') << std::setw(2) << (int)(unsigned char)c;
                    } else {
                        o << c;
                    }
            }
        }
        o << '"';
        return o.str();
    }

    std::mutex mu_;
    bool bootstrapped_ = false;
    bool flushed_ = false;
    bool stdout_capture_on_ = false;
    std::string output_path_;
    std::string src_name_;
    std::vector<std::string> src_lines_;
    std::vector<Scope> scopes_;                // stack
    std::vector<LoopCounter> loop_stack_;      // stack
    std::vector<Step> steps_;
    std::string pre_step_output_;
    std::ostringstream capture_;
    std::streambuf* real_buf_ = nullptr;
};

// RAII for push/pop_scope (__RT_FN).
struct ScopeGuard {
    ScopeGuard() { Recorder::instance().push_scope(); }
    explicit ScopeGuard(const char* fn) { Recorder::instance().push_scope(fn); }
    ~ScopeGuard() { Recorder::instance().pop_scope(); }
};

// Combines bootstrap + main scope lifetime. Must be a local in main() so its
// lifetime covers the whole program (not inside a do-while!).
struct BootstrapGuard {
    BootstrapGuard(const char* json_path, const char* src_name,
                   const char* const* src_lines, int src_n) {
        Recorder::instance().bootstrap(json_path, src_name, src_lines, src_n);
        Recorder::instance().push_scope("main");
    }
    ~BootstrapGuard() {
        Recorder::instance().pop_scope();
#if RETRACE_WASM_BUILD
        // On WASM, atexit doesn't reliably fire — flush explicitly.
        Recorder::instance().flush_to_disk();
#endif
    }
};

// RAII for loop begin/end (__RT_LOOP_BEGIN / __RT_LOOP_END).
// BEGIN bumps counter entry; END pops the loop. Note that we increment
// per-step *before* each body step via step_record(..., id). The current
// design uses this simpler model: no separate increment macro.
struct LoopGuard {
    std::string id;
    explicit LoopGuard(std::string id_) : id(std::move(id_)) {
        Recorder::instance().loop_push(id);
    }
    ~LoopGuard() {
        Recorder::instance().loop_pop(id);
    }
};

}  // namespace retrace

#endif  // RETRACE_WASM_BUILD

// =============================================================================
// User-facing macros
// =============================================================================
// A note on compound-statement wrapping: the macros expand to single
// statements so they're safe after an if/for/while without braces. We use
// do { ... } while (0) where multiple statements are required.

// Note: brace-initialisation avoids C++'s Most Vexing Parse (a declaration
// like `ScopeGuard v(arg);` would otherwise be parsed as a *function*
// declaration, silently skipping any push/pop — the classic gotcha).
//
// `__RT_MAIN` expands to a LOCAL VARIABLE declaration so the guard lives for
// the whole of main() — never wrap it in a do {} while (0), which would
// destroy the guard immediately after evaluating the macro.
#define __RT_MAIN(json_path)                                                      \
    ::retrace::BootstrapGuard __rt_boot_guard{json_path, __rt_source_name,       \
                                             __rt_source_lines,                   \
                                             __rt_source_lines_n}

#define __RT_FN ::retrace::ScopeGuard __rt_scope_guard{__func__}

// Instrumenter-provided macros.
#define __RT_STEP(line)                                                          \
    ::retrace::Recorder::instance().step_record(line)

// User-side helper for function parameters (the regex instrumenter cannot
// harvest parameter declarations from function definitions). Drop one per
// formal parameter immediately after the __RT_FN line.
#define __RT_PARAM(name)                                                         \
    ::retrace::Recorder::instance().reg_var(#name, name)

// Note: for loop "enter body" bump, the current LOOP_BEGIN guard ensures we
// increment on each body statement AFTER the first; to also bump entry once
// when we enter the iteration's first statement, we pre-register a side-
// effect in the step macro by prepending __rt_loop_entry_##line. Concretely,
// when we use a single step_record() the bump is done externally: the
// LoopGuard push happened at body entry, and step_record() increments the top
// loop counter by looking at a "hint id". We keep the simple design and
// increment the top loop every time a step happens while inside a LoopGuard
// push. To track "first step of each iteration", we increment counter at end
// of each step after the first? Simpler: let __RT_LOOP_BEGIN bump by 0 on
// push, __RT_STEP increment the top-of-stack counter once per step. That
// over-counts for nested bodies.  Accepting that, we have an approximation:
// counters count total STEPS in body, not iterations. To be accurate we'd
// need to instrument a bump at the start of iteration header, not at body
// statements.
//
// Trade-off for Phase 2 regex: record "step count inside loop" instead of
// iteration count. Total stays equal to current for monotone. The bar still
// grows as you go deeper in the loop. That's fine. We note it in README.

#define __RT_VAR(line, name)                                                     \
    ::retrace::Recorder::instance().reg_var(#name, name)

#define __RT_LOOP_BEGIN(id)                                                      \
    ::retrace::LoopGuard __rt_loop_##id(#id)

#define __RT_LOOP_END(id) static_assert(true, "retrace: loop_end no-op")

#endif  // RETRACE_H_
