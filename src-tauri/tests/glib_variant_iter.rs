//! RUSTSEC-2024-0429: exercise the actual GTK-compatible glib dependency.
#![cfg(target_os = "linux")]

use glib::prelude::*;

#[test]
fn variant_string_iteration_preserves_borrowed_values_in_both_directions() {
    let values = ["first", "", "հայերեն", "last"];
    let variant = values.to_variant();
    let iter = || variant.array_iter_str().expect("string array");

    assert_eq!(iter().collect::<Vec<_>>(), values);
    assert_eq!(
        iter().rev().collect::<Vec<_>>(),
        ["last", "հայերեն", "", "first"]
    );
    assert_eq!(iter().nth(2), Some("հայերեն"));
    assert_eq!(iter().nth_back(2), Some(""));
    assert_eq!(iter().last(), Some("last"));

    let mut mixed = iter();
    assert_eq!(mixed.next(), Some("first"));
    assert_eq!(mixed.next_back(), Some("last"));
    assert_eq!(mixed.next_back(), Some("հայերեն"));
    assert_eq!(mixed.next(), Some(""));
    assert_eq!(mixed.next(), None);
    assert_eq!(mixed.next_back(), None);

    let empty: [&str; 0] = [];
    let empty_variant = empty.to_variant();
    assert_eq!(
        empty_variant
            .array_iter_str()
            .expect("empty string array")
            .next(),
        None
    );
}
