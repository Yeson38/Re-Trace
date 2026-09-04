namespace { const char* __rt_source_name = "samples/gcd_while.cpp";
  const char* const __rt_source_lines[] = {
    "#include \"retrace.h\"",
    "#include <iostream>",
    "",
    "int gcd(int a, int b) {",
    "  __RT_FN;",
    "  __RT_PARAM(a);",
    "  __RT_PARAM(b);",
    "  while (b != 0) {",
    "    int t = a % b;",
    "    a = b;",
    "    b = t;",
    "  }",
    "  return a;",
    "}",
    "",
    "int main() {",
    "  __RT_MAIN(\"gcd_while.trace.json\");",
    "  std::cout << gcd(48, 18) << std::endl;",
    "  return 0;",
    "}",
  };
  const int __rt_source_lines_n = 20;
}
#include "retrace.h"
#include <iostream>

int gcd(int a, int b) {
  __RT_FN;
__RT_STEP(5);
__RT_STEP(6);
  __RT_PARAM(a);
__RT_STEP(7);
  __RT_PARAM(b);
__RT_STEP(8);
__RT_LOOP_BEGIN(L8);
  while (b != 0) {
__RT_STEP(9);
    int t = a % b;
__RT_VAR(9, t);
__RT_STEP(10);
    a = b;
__RT_STEP(11);
    b = t;
  }
  return a;
}

int main() {
  __RT_MAIN("gcd_while.trace.json");
__RT_STEP(17);
__RT_STEP(18);
  std::cout << gcd(48, 18) << std::endl;
  return 0;
}
__RT_LOOP_END(L8);
