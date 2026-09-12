#include "retrace.h"
#include <iostream>
#include <vector>

void bubble_sort(std::vector<int> &arr) {
  __RT_FN;
  __RT_PARAM(arr);
  int n = (int)arr.size();
  for (int i = 0; i < n; ++i) {
    for (int j = 0; j < n - i - 1; ++j) {
      if (arr[j] > arr[j + 1]) {
        int tmp = arr[j];
        arr[j] = arr[j + 1];
        arr[j + 1] = tmp;
      }
    }
  }
}

int main() {
  __RT_MAIN("bubble_sort.trace.json");
  std::vector<int> data = {5, 2, 8, 1, 4};
  bubble_sort(data);
  for (size_t i = 0; i < data.size(); ++i) {
    if (i) std::cout << " ";
    std::cout << data[i];
  }
  std::cout << std::endl;
  return 0;
}
