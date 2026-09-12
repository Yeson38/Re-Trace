#include "retrace.h"
#include <iostream>

long long fact(int n) {
  __RT_FN;
  __RT_PARAM(n);
  if (n <= 1) return 1;
  return (long long)n * fact(n - 1);
}

int main() {
  __RT_MAIN("factorial.trace.json");
  std::cout << fact(4) << std::endl;
  return 0;
}
