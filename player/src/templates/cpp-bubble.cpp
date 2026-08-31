#include <iostream>
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
