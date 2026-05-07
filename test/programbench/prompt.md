# Reverse Engineering Project

You are reverse engineering a compiled binary from scratch. You have access
to whatever documentation files ship in this directory (READMEs, man pages,
license, etc.). The binary itself is executable-only — you cannot read or
decompile it.

The eval will run `chmod +x ./compile.sh && ./compile.sh` to build your
submission, then test the resulting `./executable` against a comprehensive
behavioral suite you cannot see. The suite tests every flag, mode, and option
the binary documents. Your submission must include `./compile.sh` and the
source files it needs.

{{orientation}}

## Required Deliverables

- [ ] `SPEC.md` - Complete specification of `executable`, with topical @tags for ALL functionality
- [ ] `implement.sh` - Compiles all four deliverable executables and test `implementation` against all three tests
- [ ] `implementation` - Perfect reimplementation of `executable`
- [ ] `test/unit` - Unit testing of all `SPEC.md` @tags
- [ ] `test/intg` - Integration testing of all `SPEC.md` @tags
- [ ] `test/e2e` - End to end testing of all `SPEC.md` @tags
- [ ] `compile.sh` - Copy of `implement.sh` which overwrites `executable` (Final Delivery Step)

* Begin with `./executable --help`, then experimentally probe for ALL functionality
* All three tests must be written in the same language as the implementation
* Iteratively test against both `./executable` and `./implementation` (test the tests)
* Apply modular design principles, including the `SPEC.md` @tags in comments

## Final Delivery Step: YOU MUST NOT perform before all is implemented and passing

If (and only if) `implement.sh` successfully compiles `implementation` and
it passes all three compiled tests, copy `implement.sh` to `compile.sh`, change
its compilation target to `executable`, confirm that the new executable also
passes the tests. Only then have you delivered and you may complete.
