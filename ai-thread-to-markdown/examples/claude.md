---
title: "Reversing lists in Python"
source: "https://claude.ai/chat/0b1c2d3e"
platform: Claude
exported: 2026-10-02T17:58:53+00:00
messages: 4
---

# Reversing lists in Python

## User

**Attachments:** notes.txt

How do I reverse a list?
Here is what I tried:

def rev(xs):
    for i in range(len(xs)):

        pass

It doesn't work — why? Using *args and __init__ here.

## Claude

<details>
<summary>Thought process</summary>

The user wants to reverse a list. Mention slicing and reversed().

</details>

### Reversing a list

Your loop never builds a new list. Use `reversed()` or slicing — both are **O(n)**.

```python
def rev(xs):
    return xs[::-1]


print(rev([1, 2]))  # [2, 1]
```

#### Options

- `xs[::-1]` — returns a copy
- `xs.reverse()` — in place
  - returns `None`
  - mutates *the original*
- `reversed(xs)` — lazy iterator

1. Pick one
2. Run `pytest -q`

```bash
pip install pytest
pytest -q
```

| Method     | Copy? | Cost |
| ---------- | ----- | ---: |
| `xs[::-1]` | yes   | O(n) |
| `a \| b`   | n/a   | O(1) |

Inline math $O(n)$ and a display formula:

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

> Readability counts.

See the [Python docs](https://docs.python.org/3/library/functions.html#reversed).\
Thanks!

> **Artifact:** List helpers (Code · PYTHON)

## User

Show it in JS, and a fenced example in markdown.

## Claude

Here:

```javascript
const rev = (xs) => [...xs].reverse();

console.log(rev([1, 2, 3]));
```

````markdown
```js
console.log(1)
```
````
