# Testing and delivery

For every change, follow [the testing policy](TESTING.md): select affected suites,
record their results, and reuse a successful PR validation for identical source
on main. Keep full browser runs for changes whose impact spans the whole app or
an explicit full-run request. Compare built asset hashes before deciding whether
production needs another functional test.
