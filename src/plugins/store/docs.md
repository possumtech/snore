## <store path="[path/to/file]"/> - Store a file or entry
Example: <store path="src/config.js"/>
Example: <store path="src/**/*.test.js"/> (store all test files at once)
* <store/> removes the file or entry from context, but does not delete it
* A stored file or entry can be restored with <get/>
* Paths accept globs for bulk operations
