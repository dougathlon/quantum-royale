# Third-party notices

Quantum Royale's browser bundle includes Phaser 3.

## Phaser

The MIT License (MIT)

Copyright (c) 2024 Richard Davey, Phaser Studio Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Project: <https://phaser.io/>

## Offline development dependencies

The repository's optional offline compiler uses pinned public revisions of Moth's QuantumGraph and pairwise-tomography packages, plus Qiskit 2.2.3 and Qiskit Aer 0.17.2. These dependencies are not redistributed in this browser artifact. The shipped fixture was produced by a local finite-shot Aer run; browser play does not bundle or execute QuantumGraph, pairwise-tomography, Qiskit, or Aer.

## Runtime art

The browser loads generated PNG sheets for six chickens, two commentator portraits, and one shield icon. They are deterministic outputs of checked-in, hand-specified pixel definitions. Legacy SVG sources remain in the source repository and are not copied into this production artifact. Original project content is licensed separately under CC BY-NC 4.0; see the repository's `LICENSES.md`.
