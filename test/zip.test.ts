import { statSync } from 'fs'
import { zipDirectory } from '../src/zip'
import { expect } from 'chai'

describe('Zip Directory', ()=>{
    it('should zip ironworkss', async ()=>{
        const statsBefore = statSync('./test/mock_data/zipTest/testFile.txt')
        const outFile = './dist/testFile.zip'
        await zipDirectory('./test/mock_data/zipTest', outFile)
        const stats = statSync(outFile)
        expect(stats.size).to.be.lessThan(statsBefore.size)
    })
})