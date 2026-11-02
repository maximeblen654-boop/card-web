// Install local regression tests into the pinned cloud checkout, not production.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const test = `package application

import (
    "errors"
    "testing"
    mappingcontract "github.com/dujiao-next/internal/modules/catalog/mapping/contract"
    mappingdomain "github.com/dujiao-next/internal/modules/catalog/mapping/domain"
    connectioncontract "github.com/dujiao-next/internal/modules/siteconnection/contract"
    connectiondomain "github.com/dujiao-next/internal/modules/siteconnection/domain"
)

type retailConnection struct {
    mappingcontract.ConnectionProvider
    value *connectiondomain.Connection
    err error
}
func (r retailConnection) GetByID(uint) (*connectiondomain.Connection, error) {
    return r.value, r.err
}
type retailMappings struct {
    mappingcontract.MappingRepository
    called bool
    failure error
}
func (r *retailMappings) ListActiveByConnection(uint) ([]mappingdomain.Mapping, error) {
    r.called = true
    return nil, r.failure
}

func TestLaifuFixedRetailDoesNotAccessWritePath(t *testing.T) {
    // Every downstream dependency is nil: entering the old write path panics.
    s := &Service{connections: retailConnection{value: &connectiondomain.Connection{AutoSyncPrice:false}}}
    count, err := s.ReapplyMarkup(1)
    if err != nil || count != 0 { t.Fatalf("count=%d error=%v", count, err) }
}
func TestLaifuAutomaticPricingStillReachesMappings(t *testing.T) {
    sentinel := errors.New("mapping repository unavailable")
    repo := &retailMappings{failure:sentinel}
    s := &Service{connections:retailConnection{value:&connectiondomain.Connection{AutoSyncPrice:true}}, mappings:repo}
    _, err := s.ReapplyMarkup(1)
    if !repo.called || !errors.Is(err,sentinel) { t.Fatal("automatic pricing was bypassed") }
}
func TestLaifuFixedRetailPreservesConnectionErrors(t *testing.T) {
    sentinel := errors.New("connection repository unavailable")
    for _, tc := range []struct{ provider retailConnection; expected error }{
        {retailConnection{}, connectioncontract.ErrNotFound},
        {retailConnection{err:sentinel}, sentinel},
    } {
        s := &Service{connections:tc.provider}
        _, err := s.ReapplyMarkup(1)
        if !errors.Is(err,tc.expected) { t.Fatalf("error=%v expected=%v",err,tc.expected) }
    }
}
`;
writeFileSync(resolve(process.argv[2] || 'upstream',
  'internal/modules/catalog/mapping/application/laifu_retail_test.go'), test);
