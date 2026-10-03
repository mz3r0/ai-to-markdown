---
title: "What is Rust's ownership model?"
source: "https://www.perplexity.ai/search/what-is-rust-ownership-AbCdEf"
platform: Perplexity
exported: 2026-10-02T17:58:54+00:00
messages: 4
---

# What is Rust's ownership model?

## User

What is Rust's ownership model?

## Perplexity

Rust manages memory through **ownership**: every value has a single owner, and the value is dropped when the owner goes out of scope. [[1]](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html) Borrowing lets code use a value without taking ownership. [[2]](https://en.wikipedia.org/wiki/Rust_(programming_language))

### Key rules

1. Each value has one owner. [[1]](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)
2. There can be one owner at a time.

#### Example

```rust
fn main() {
    let s1 = String::from("hello");
    let s2 = s1; // s1 is moved

    println!("{s2}");
}
```

A table of moves vs copies:

| Type     | Behaviour |
| -------- | --------- |
| `String` | Move      |
| `i32`    | Copy      |

**Sources**

1. [doc.rust-lang.org](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)
2. [en.wikipedia.org](https://en.wikipedia.org/wiki/Rust_(programming_language))

## User

Show borrowing with a function.
Keep it short.

## Perplexity

Pass a reference with `&`: [[1]](https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html)

```rust
fn len(s: &String) -> usize {
    s.len()
}
```

**Sources**

1. [doc.rust-lang.org](https://doc.rust-lang.org/book/ch04-02-references-and-borrowing.html)
