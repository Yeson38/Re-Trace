namespace { const char* __rt_source_name = "samples/bubble_sort.cpp";
  const char* const __rt_source_lines[] = {
    "#include \"retrace.h\"",
    "#include <iostream>",
    "#include <vector>",
    "",
    "void bubble_sort(std::vector<int> &arr) {",
    "  __RT_FN;",
    "  __RT_PARAM(arr);",
    "  int n = (int)arr.size();",
    "  for (int i = 0; i < n; ++i) {",
    "    for (int j = 0; j < n - i - 1; ++j) {",
    "      if (arr[j] > arr[j + 1]) {",
    "        int tmp = arr[j];",
    "        arr[j] = arr[j + 1];",
    "        arr[j + 1] = tmp;",
    "      }",
    "    }",
    "  }",
    "}",
    "",
    "int main() {",
    "  __RT_MAIN(\"bubble_sort.trace.json\");",
    "  std::vector<int> data = {5, 2, 8, 1, 4};",
    "  bubble_sort(data);",
    "  for (size_t i = 0; i < data.size(); ++i) {",
    "    if (i) std::cout << \" \";",
    "    std::cout << data[i];",
    "  }",
    "  std::cout << std::endl;",
    "  return 0;",
    "}",
  };
  const int __rt_source_lines_n = 30;
}
#include "retrace.h"
#include <iostream>
#include <vector>

void bubble_sort(std::vector<int> &arr) {
  __RT_FN;
__RT_STEP(6);
__RT_STEP(7);
  __RT_PARAM(arr);
__RT_STEP(8);
  int n = (int)arr.size();
__RT_VAR(8, n);
__RT_STEP(9);
__RT_LOOP_BEGIN(L9);
  for (int i = 0; i < n; ++i) {
__RT_VAR(9, i);
__RT_STEP(10);
__RT_LOOP_BEGIN(L10);
    for (int j = 0; j < n - i - 1; ++j) {
__RT_VAR(10, j);
__RT_STEP(11);
      if (arr[j] > arr[j + 1]) {
__RT_STEP(12);
        int tmp = arr[j];
__RT_VAR(12, tmp);
__RT_STEP(13);
        arr[j] = arr[j + 1];
__RT_STEP(14);
        arr[j + 1] = tmp;
__RT_LOOP_END(L10);
      }
__RT_LOOP_END(L9);
    }
  }
}

int main() {
  __RT_MAIN("bubble_sort.trace.json");
__RT_STEP(21);
__RT_STEP(22);
  std::vector<int> data = {5, 2, 8, 1, 4};
__RT_VAR(22, data);
__RT_STEP(23);
  bubble_sort(data);
__RT_STEP(24);
__RT_LOOP_BEGIN(L24);
  for (size_t i = 0; i < data.size(); ++i) {
__RT_VAR(24, i);
__RT_STEP(25);
    if (i) std::cout << " ";
__RT_STEP(26);
    std::cout << data[i];
  }
__RT_STEP(28);
  std::cout << std::endl;
  return 0;
}
__RT_LOOP_END(L24);
