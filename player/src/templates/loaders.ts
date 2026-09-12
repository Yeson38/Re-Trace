/**
 * Phase 4 — Template source loaders.
 *
 * Default sample code shown when the user clicks "新建".
 * Uses ?raw imports so Vite bundles the source as strings.
 */
export const PYTHON_BUBBLE = `def bubble_sort(arr):
    n = len(arr)
    for i in range(n):
        for j in range(0, n - i - 1):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr

data = [5, 2, 8, 1, 4]
result = bubble_sort(data)
print(result)
`;

export const CPP_BUBBLE = `#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

void bubble_sort(vector<int>& arr) {
    int n = arr.size();
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n - i - 1; j++) {
            if (arr[j] > arr[j + 1]) {
                swap(arr[j], arr[j + 1]);
            }
        }
    }
}

int main() {
    vector<int> data = {5, 2, 8, 1, 4};
    bubble_sort(data);
    for (int x : data) cout << x << " ";
    cout << endl;
    return 0;
}
`;
