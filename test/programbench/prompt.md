We're currently reproducing the following program from scratch.

The compiled binary `./executable` is the reference. You have access to
whatever documentation files ship in this directory (READMEs, man pages,
license, etc.). The binary itself is executable-only — you cannot read
or decompile it.

{{orientation}}

The eval will run `chmod +x ./compile.sh && ./compile.sh` to build your
submission, then test the resulting `./executable` against a behavioral
suite. The suite tests every flag, mode, and option the binary documents.
Your submission must include `./compile.sh` and the source files it needs.

## Recommended Workflow

### YOU MUST draft a SPEC.md.
Run `./executable --help` and probe the
executable with representative inputs, then create the first draft of a
comprehensive and complete SPEC.md that fully documents the functionality
in tagged sections (e.g. #flag_b, #arg2, etc...) and also attempts to
discern the design and structure of the inspiration binary internals.

### YOU MUST design unit, integration, and e2e tests
Design them against the pre-existing binary that include the section tags,
ensuring perfect 1:1:1 alignment between inspiration, specification, and
testing. All of the testing infrastructure must be in the same language
the implementation will be in.

### YOU MUST modularize
After designing a testing suite that delivers 100% coverage and passage
of the inspiration binary, wireframe the anticipated file and folder
structure of the implementation. Then implement it, interpolating topical
references to all of the specification tags throughout the codebase.

### YOU MUST iterate
Rapidly and routinely iterate the implementation against the testing suite,
revising the specification and testing suite as more correct and complete
practices are learned and discovered. Also, continue testing the inspiration
binary against the test suite to defend against degenerating tests. You cannot
deliver until achieving perfect 1:1:1:1 alignment between implementation,
inspiration, specification, and testing.

### YOU MUST verify

Before submitting to the evaluation suite you cannot see, run
`chmod +x ./compile.sh && ./compile.sh` from a clean state (again) and
confirm it exits 0 with no compile errors. A passing harness + clean
compile is the prerequisite for completion.
