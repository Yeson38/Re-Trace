namespace { const char* __rt_source_name = "samples/factorial.cpp";
  const char* const __rt_source_lines[] = {
    "#include \"retrace.h\"",
    "#include <iostream>",
    "",
    "long long fact(int n) {",
    "  __RT_FN;",
    "  __RT_PARAM(n);",
    "  if (n <= 1) return 1;",
    "  return (long long)n * fact(n - 1);",
    "}",
    "",
    "int main() {",
    "  __RT_MAIN(\"factorial.trace.json\");",
    "  std::cout << fact(4) << std::endl;",
    "  return 0;",
    "}",
  };
  const int __rt_source_lines_n = 15;
}
#include "retrace.h"
#include <iostream>

long long fact(int n) {
  __RT_FN;
__RT_STEP(5);
__RT_STEP(6);
  __RT_PARAM(n);
__RT_STEP(7);
  if (n <= 1) return 1;
  return (long long)n * fact(n - 1);
}

int main() {
  __RT_MAIN("factorial.trace.json");
__RT_STEP(12);
__RT_STEP(13);
  std::cout << fact(4) << std::endl;
  return 0;
}
