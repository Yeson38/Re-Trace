#include "retrace.h"
#include <iostream>

int gcd(int a, int b) {
  __RT_FN;
  __RT_PARAM(a);
  __RT_PARAM(b);
  while (b != 0) {
    int t = a % b;
    a = b;
    b = t;
  }
  return a;
}

int main() {
  __RT_MAIN("gcd_while.trace.json");
  std::cout << gcd(48, 18) << std::endl;
  return 0;
}
